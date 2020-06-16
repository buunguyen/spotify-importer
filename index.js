#!/usr/bin/env node

import path from 'path';
import readline from 'readline';
import yargs from 'yargs';
import {promises as fs} from 'fs';
import csvWriter from 'csv-writer';
import csvParse from 'csv-parse';
import SpotifyWebApi from 'spotify-web-api-node';
import mm from 'music-metadata';

const {createArrayCsvWriter: createCsvWriter} = csvWriter;

const options = yargs
  .command('generate-csv', 'Generate a track CSV file from a directory', (yargs) => {
    return yargs
      .option('i', {alias: 'input', describe: 'Input directory', type: 'string', demandOption: true})
      .option('o', {alias: 'output', describe: 'Target CSV file', type: 'string', demandOption: true})
      .option('f', {alias: 'filter', describe: 'Regex string to remove from file name', type: 'string', demandOption: false})
  }, generateCsv)
  .command('import-tracks', 'Import tracks from a CSV file to Spotify', (yargs) => {
    return yargs
      .option('i', {alias: 'input', describe: 'Input CSV file', type: 'string', demandOption: true})
      .option('c', {alias: 'clientId', describe: 'Spotify app client ID', type: 'string', demandOption: true})
      .option('s', {alias: 'clientSecret', describe: 'Spotify app client secret', type: 'string', demandOption: true})
      .option('r', {alias: 'redirectUri', describe: 'Redirect URL (must match the one specified in Spotify)', type: 'string', demandOption: true})
      .option('u', {alias: 'username', describe: 'Spotify username', type: 'string', demandOption: false})
      .option('f', {alias: 'refreshToken', describe: 'Access token (if already have it)', type: 'string', demandOption: false})
      .option('p', {alias: 'defaultPlaylist', describe: 'Default playlist', type: 'string', demandOption: false})
  }, importTracks)
  .argv;

///=== Task 1: generate CSV
async function generateCsv({input, output, filter = ''}) {
  const csvWriter = createCsvWriter({path: output});
  const files = await fs.readdir(input);
  const rows = [];

  for (const file of files) {
    const {trackName, artist, playlists} = await parseMusicFile({filename: file, filter, dir: input});
    rows.push([trackName, artist, playlists, '']);
  }

  await csvWriter.writeRecords(rows);
}

async function parseMusicFile({filename, dir, filter}) {
  const fullpath = path.join(dir, filename);
  let trackName, artist, playlists;

  try {
    const metadata = await mm.parseFile(fullpath);
    trackName = metadata.common.title;
    artist = ((metadata.common.artist || metadata.common.artists[0]) || '').split(/[,/]+/)[0].trim();
    playlists = (metadata.common.genre || []).map((genre) => genre.split(/[,/]+/)[0].trim()).join('|');
  } catch (ignored) {}

  if (!trackName) {
    trackName = path.parse(filename).name.replace(new RegExp(filter, 'g'), '').trim();
  }
  if (!artist) {
    try {
      artist = path.parse(filename).name.split('-')[1].trim();
    } catch (ignored) {
      artist = '';
    }
  }
  if (!playlists) {
    playlists = '';
  }
  return {trackName, artist, playlists};
}

///=== Task 2: import tracks
async function importTracks(argv) {
  const {rows, tracks, artists, playlists, uris} = await parseSource(argv);
  const api = await auth(argv);

  // Put tracks into playlist groups
  const groups = {};
  const failures = [];
  for (let i = 0; i < tracks.length; i++) {
    if (!uris[i]) {
      const track = await findTrack({api, track: tracks[i], artist: artists[i]});
      if (!track) {
        failures.push([tracks[i], artists[i], playlists[i].join('|'), '']);
        continue;
      }

      uris[i] = rows[i][3] = track.uri;
    }

    for (const playlist of playlists[i]) {
      groups[playlist] = (groups[playlist] || []).concat(uris[i]);
    }
  }

  // Create playlist (if not exist) and add tracks
  const {body: {items: onlinePlaylists}} = await api.getUserPlaylists(argv.username);
  for (const playlistName of Object.keys(groups)) {
    console.log(`Importing playlist '${playlistName}': ${groups[playlistName].length}...`);
    let onlinePlaylist = onlinePlaylists.find((pl) => pl.name === playlistName);
    if (!onlinePlaylist) {
      console.log(`Creating playlist '${playlistName}'...`)
      onlinePlaylist = (await api.createPlaylist(argv.username, playlistName, {public: false})).body;
    }

    // If more than 100, throw 400, thus, chunk first
    for (const chunk of chunkArray(groups[playlistName], 100)) {
      await api.addTracksToPlaylist(onlinePlaylist.id, chunk);
    }
  }

  // Write file with URIs so it could be the input for the next run (faster)
  createCsvWriter({path: path.parse(argv.input).name + '.done.cvs'}).writeRecords(rows);

  // Write all failures to a file so it could be input for a re-run (after manually update)
  if (failures.length) {
    console.log(`Failures: ${failures.length}`);
    createCsvWriter({path: path.parse(argv.input).name + '.failed.csv'}).writeRecords(failures);
  }
}

async function findTrack({api, track, artist, playlists}) {
  let query = `track:${track}`;
  if (artist) {
    query += ` artist:${artist}`;
  }
  const {body: {tracks: {items}}} = await api.searchTracks(query);
  return items[0];
}

async function parseSource({input, username, defaultPlaylist = 'imported'}) {
  const fileData = await fs.readFile(input);
  const rows = await new Promise((resolve, reject) => {
    csvParse(fileData, {}, (err, rows) => resolve(rows));
  });
  const tracks = rows.map((row) => row[0].trim());
  const artists = rows.map((row) => row[1].trim());
  const playlists = rows.map((row) => row[2].trim().split('|').filter((playlist) => !!playlist).concat(defaultPlaylist));
  const uris = rows.map((row) => row[3].trim());
  return {rows, tracks, artists, playlists, uris};
}

async function auth({clientId, clientSecret, redirectUri, refreshToken}) {
  const api = new SpotifyWebApi({
    clientId,
    clientSecret,
    redirectUri,
  });

  if (!refreshToken) {
    const authorizeURL = api.createAuthorizeURL([
      'playlist-read',
      'playlist-read-private',
      'playlist-modify',
      'playlist-modify-private',
      'user-library-read',
      'user-library-modify',
    ], 'spotify-importer-state-value');
    console.log(`Copy and paste this to your browser '${authorizeURL}'. Follow the steps. Then copy the value of the 'code' query string.`);

    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    const authCode = await prompt('Enter code here: ');
    const data = await api.authorizationCodeGrant(authCode);

    refreshToken = data.body['refresh_token'];
    api.setAccessToken(data.body['access_token']);
    api.setRefreshToken(refreshToken);

    console.log('Refresh token: ' + refreshToken);
  } else {
    api.setRefreshToken(refreshToken);
    const data = await api.refreshAccessToken();
    api.setAccessToken(data.body['access_token']);
  }
  return api;
}

// Utils
function log(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function prompt(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }))
}

function chunkArray(arr, size) {
  const results = [];
  while (arr.length) {
    results.push(arr.splice(0, size));
  }
  return results;
}
