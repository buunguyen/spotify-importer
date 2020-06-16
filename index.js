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

/// Command line parsers
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
      .option('c', {alias: 'clientId', describe: 'Spotify App Client ID', type: 'string', demandOption: true})
      .option('s', {alias: 'clientSecret', describe: 'Spotify App Client Secret', type: 'string', demandOption: true})
      .option('r', {alias: 'redirectUri', describe: 'Spotify Auth Redirect URI (must match the one specified in Spotify)', type: 'string', demandOption: true})
      .option('u', {alias: 'userId', describe: 'Spotify user ID', type: 'string', demandOption: true})
      .option('f', {alias: 'refreshToken', describe: 'Refresh token (if already have it)', type: 'string', demandOption: false})
      .option('p', {alias: 'defaultPlaylist', describe: 'Default playlist', type: 'string', demandOption: false})
  }, importTracks)
  .argv;

/// Exception handling
process.on('uncaughtException', (err) => logError(err));
process.on('unhandledRejection', (reason, promise) => logError(reason));
function logError(err) {
  console.log('Unexpected error. Check the data and try re-run the script.')
  console.log(err);
}

///=== Task 1: generate CSV
async function generateCsv({input, output, filter = ''}) {
  const csvWriter = createCsvWriter({path: output});
  const files = await fs.readdir(input);
  const rows = await Promise.all(files.map(async (file) => {
    const {trackName, artist, playlists} = await parseMusicFile({filename: file, filter, dir: input});
    return [trackName, artist, playlists, ''] ;
  }));
  await csvWriter.writeRecords(rows);
}

async function parseMusicFile({filename, dir, filter}) {
  let trackName = '';
  let artist = '';
  let playlists = '';

  try {
    const fullpath = path.join(dir, filename);
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
    } catch (ignored) {}
  }

  return {trackName, artist, playlists};
}

///=== Task 2: import tracks
async function importTracks(argv) {
  const {tracks, artists, playlists, uris} = await parseSource(argv);
  const api = await auth(argv);

  // Find tracks and populate the the playlist groups: mapping between <playlist> -> <track 1> <track 2> <track n>
  const playlistGroups = {};
  const foundTracks = [];
  const failedTracks = [];

  console.log('Finding tracks, gonna take a while if there are many tracks...');
  for (let i = 0; i < tracks.length; i++) {
    // If URI is supplied (e.g. by previous run), use it, if not, find the track on Spotify
    if (!uris[i]) {
      const track = await findTrack({api, track: tracks[i], artist: artists[i]});
      if (!track) {
        failedTracks.push([tracks[i], artists[i], playlists[i].join('|'), '']);
        continue;
      }
      uris[i] = track.uri;
    }
    foundTracks.push([tracks[i], artists[i], playlists[i].join('|'), uris[i]]);
    for (const playlist of playlists[i]) {
      playlistGroups[playlist] = (playlistGroups[playlist] || []).concat(uris[i]);
    }
  }

  // Create playlists, if not exist, and add tracks to them
  const {body: {items: spotifyPlaylists}} = await api.getUserPlaylists(argv.userId);
  for (const playlistName of Object.keys(playlistGroups)) {
    console.log(`Importing playlist '${playlistName}': ${playlistGroups[playlistName].length}...`);
    let spotifyPlaylist = spotifyPlaylists.find((pl) => pl.name === playlistName);
    if (!spotifyPlaylist) {
      // Playlist not exist on Spotify yet, create it now
      console.log(`Creating playlist '${playlistName}'...`)
      spotifyPlaylist = (await api.createPlaylist(argv.userId, playlistName, {public: false})).body;
    }

    // The API only allows a number of tracks per request, so chunk if the playlist is big
    for (const chunkOfTracks of chunkArray(playlistGroups[playlistName], 100)) {
      await api.addTracksToPlaylist(spotifyPlaylist.id, chunkOfTracks);
    }
  }

  // Write file with URIs for found tracks
  createCsvWriter({path: path.parse(argv.input).name + '.found.csv'}).writeRecords(foundTracks);

  // Write all failed tracks to a file so it could be input for a re-run (after manually update)
  if (failedTracks.length) {
    const failedFilePath = path.parse(argv.input).name + '.failed.csv';
    console.log(`Couldn't import ${failedTracks.length} tracks. Details are in '${failedFilePath}'. Update that file and use it as input for the next run.`);
    createCsvWriter({path: failedFilePath}).writeRecords(failedTracks);
  } else {
    console.log('ALL DONE 🎉🎊🥳! All tracks were imported')
  }
}

async function findTrack({api, track, artist, playlists}) {
  let query = `track:${track}`;
  if (artist) {
    query += ` artist:${artist}`;
  }
  const {body: {tracks: {items}}} = await api.searchTracks(query);

  // TODO: probably better if allow to choose among the options
  return items[0];
}

async function parseSource({input, defaultPlaylist = 'imported'}) {
  const fileData = await fs.readFile(input);
  const rows = await new Promise((resolve, reject) => {
    csvParse(fileData, {}, (err, rows) => resolve(rows));
  });
  const tracks = rows.map((row) => row[0].trim());
  const artists = rows.map((row) => row[1].trim());
  const playlists = rows.map((row) => row[2]
    .trim()
    .split('|')
    .concat(defaultPlaylist)
    .filter((playlist, index, playlists) => !!playlist && playlists.indexOf(playlist) === index)
  );
  const uris = rows.map((row) => row[3].trim());
  return {tracks, artists, playlists, uris};
}

async function auth({clientId, clientSecret, redirectUri, refreshToken}) {
  const api = new SpotifyWebApi({clientId, clientSecret, redirectUri});

  if (refreshToken) {
    // If refresh token is provided, set it and get the access token
    api.setRefreshToken(refreshToken);
    const data = await api.refreshAccessToken();
    api.setAccessToken(data.body['access_token']);
  } else {
    // If refresh token isn't supplied, we'll follow the code grant auth pattern to get user's permission.
    const authorizeURL = api.createAuthorizeURL([
      'playlist-read',
      'playlist-read-private',
      'playlist-modify',
      'playlist-modify-private',
      'user-library-read',
      'user-library-modify',
    ], 'spotify-importer-state-value');
    console.log(`Copy and paste this to your browser '${authorizeURL}'. Follow the steps on Spotify website. Then copy the value of the 'code' query string.`);

    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    const authCode = await prompt('Paste code here and press Enter: ');
    const data = await api.authorizationCodeGrant(authCode);

    refreshToken = data.body['refresh_token'];
    api.setAccessToken(data.body['access_token']);
    api.setRefreshToken(refreshToken);

    console.log('Copy the refresh token below this line so you can re-run this script faster later\n' + refreshToken);
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
