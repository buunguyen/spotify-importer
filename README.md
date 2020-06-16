## Spotify Track importer

Script to import offline music library to Spotify.
Require Node 14+.

### Generate track CSV file

This script parses a directory and creates a CSV file of all tracks. The output CSV file has 4 columns: track name, artist, playlists (separated by `|`) and the Spotify URI (empty and you don't have to bother).

Run this:

```
node ./index.js generate-csv -i <directory> -o <csv file> -f <optional filter: regexp to clean up file names>
```

You can modify the output CSV file manually like changing playlists, cleaning up filenames further etc.

### Import tracks from CSV file

This script uses the Spotify Web API to create playlists (if not exist) and add the songs to those playlists. You need to create a Spotify App to get the Client ID and Client Secret. Also, add a Redirect Uri in the app settings. It could be anything like "https://localhost:8080/callback". The server doesn't have to exist, just need something to fill in the param below and make sure it matches the one in app settings. Finally, you need the Spotify user ID, which you can find in the Spotify Profile page.

Run this and follow the instructions:

```
node ./index.js import-tracks -i <csv file> -c <client id> -s <client secret> -r <redirect uri> -u <user id>
```

Copy the 'Refresh Token' output from this run. If you need to re-run this script, do this, it will be faster:

```
node ./index.js import-tracks -i <csv file> -c <client id> -s <client secret> -r <redirect uri> -u <user id> -f <refresh token>
```

You can also add a `-p <default playlist`. Tracks are always imported to this playlist (default value if not provided is 'imported'). That way you have a single place to check all the imported tracks. If you don't want it later, you can delete it on Spotify after import.

Import failures are written in a CSV file with the `.failed.csv` suffix. Clean up that file and use it as the input for re-run. Or you might have to manually import those if Spotify Search API doesn't work for those tracks.

Tracks which were found are written to a CSV file with the `.found.csv` suffix. Use it to get the Spotify URI if you need it for some reason.

If the script fails before writing the `.failed.csv`, try re-running. Spotify API fails for several reasons including rate limit or a permission hasn't taken effect (probably due to poor data consistency).
