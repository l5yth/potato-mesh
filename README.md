# potato-mesh
a simple node dashboard for berlin mediumfast

### requirements
requires a meshtastic node connected (via serial) to gather mesh data and the meshtastic cli.

### data
uses python meshtastic library to ingest mesh data into an sqlite3 database locally

run `nodes.sh` in `data/` to keep updating node records.

### web
uses a ruby sinatra webapp to display data from the sqlite database

run `app.sh` in `web/` to run the sinatra webserver and check [127.0.0.1:41447](http://127.0.0.1:41447/) for the correct node map.

### license
apache v2.0
