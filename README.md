# spotify-importer

### Generate CSV file from a directory

node ./index.js generate-csv -i /Users/me/Music -o ./songs.csv -f "\d+|_+|\[(.+)\]"

### Import songs to Spotify

node ./index.js import-songs -i ./songs.csv -u <p;ostify username> -t <spotify token> -p <default playlist>
