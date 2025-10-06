# CHANGELOG

## v0.4.0

* Reformat neighbor overlay layout by @l5yth in <https://github.com/l5yth/potato-mesh/pull/237>
* Add legend toggle for neighbor lines by @l5yth in <https://github.com/l5yth/potato-mesh/pull/236>
* Hide Air Util Tx column on mobile by @l5yth in <https://github.com/l5yth/potato-mesh/pull/235>
* Add overlay for clickable neighbor links on map by @l5yth in <https://github.com/l5yth/potato-mesh/pull/234>
* Hide humidity and pressure columns on mobile by @l5yth in <https://github.com/l5yth/potato-mesh/pull/232>
* Remove last position timestamp from map info overlay by @l5yth in <https://github.com/l5yth/potato-mesh/pull/233>
* Improve live node positions and expose precision metadata by @l5yth in <https://github.com/l5yth/potato-mesh/pull/231>
* Show neighbor short names in info overlays by @l5yth in <https://github.com/l5yth/potato-mesh/pull/228>
* Add telemetry environment metrics to node UI by @l5yth in <https://github.com/l5yth/potato-mesh/pull/227>
* Reduce neighbor line opacity by @l5yth in <https://github.com/l5yth/potato-mesh/pull/226>
* Visualize neighbor connections on map canvas by @l5yth in <https://github.com/l5yth/potato-mesh/pull/224>
* Add clear control to filter input by @l5yth in <https://github.com/l5yth/potato-mesh/pull/225>
* Handle Bluetooth shutdown hangs gracefully by @l5yth in <https://github.com/l5yth/potato-mesh/pull/221>
* Adjust mesh priorities and receive topics by @l5yth in <https://github.com/l5yth/potato-mesh/pull/220>
* Add BLE and fallback mesh interface handling by @l5yth in <https://github.com/l5yth/potato-mesh/pull/219>
* Add neighbor info ingestion and API endpoints by @l5yth in <https://github.com/l5yth/potato-mesh/pull/218>
* Add debug logs for unknown node creation and last-heard updates by @l5yth in <https://github.com/l5yth/potato-mesh/pull/214>
* Update node last seen when events are received by @l5yth in <https://github.com/l5yth/potato-mesh/pull/212>
* Improve debug logging for node and telemetry data by @l5yth in <https://github.com/l5yth/potato-mesh/pull/213>
* Normalize stored message debug output by @l5yth in <https://github.com/l5yth/potato-mesh/pull/211>
* Stop repeating ingestor node info snapshot and timestamp debug logs by @l5yth in <https://github.com/l5yth/potato-mesh/pull/210>
* Add telemetry API and ingestion support by @l5yth in <https://github.com/l5yth/potato-mesh/pull/205>
* Add private mode to hide chat and message APIs by @l5yth in <https://github.com/l5yth/potato-mesh/pull/204>
* Handle offline-ready map fallback by @l5yth in <https://github.com/l5yth/potato-mesh/pull/202>
* Add linux/armv7 container builds and configuration options by @l5yth in <https://github.com/l5yth/potato-mesh/pull/201>
* Update Docker documentation by @l5yth in <https://github.com/l5yth/potato-mesh/pull/200>
* Update node last seen when ingesting encrypted messages by @l5yth in <https://github.com/l5yth/potato-mesh/pull/198>
* Fix api in readme by @l5yth in <https://github.com/l5yth/potato-mesh/pull/197>

## v0.3.0

* Add connection recovery for TCP interface by @l5yth in <https://github.com/l5yth/potato-mesh/pull/186>
* Bump version to 0.3 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/191>
* Pgrade styles and fix interface issues by @l5yth in <https://github.com/l5yth/potato-mesh/pull/190>
* Some updates in the front by @dkorotkih2014-hub  in <https://github.com/l5yth/potato-mesh/pull/188>
* Update last heard on node entry change by @l5yth in <https://github.com/l5yth/potato-mesh/pull/185>
* Populate chat metadata for unknown nodes by @l5yth in <https://github.com/l5yth/potato-mesh/pull/182>
* Update role color theme to latest palette by @l5yth in <https://github.com/l5yth/potato-mesh/pull/183>
* Add placeholder nodes for unknown senders by @l5yth in <https://github.com/l5yth/potato-mesh/pull/181>
* Update role colors and ordering for firmware 2.7.10 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/180>
* Handle plain IP addresses in mesh TCP detection by @l5yth in <https://github.com/l5yth/potato-mesh/pull/154>
* Handle encrypted messages by @l5yth in <https://github.com/l5yth/potato-mesh/pull/173>
* Add fallback display names for unnamed nodes by @l5yth in <https://github.com/l5yth/potato-mesh/pull/171>
* Ensure routers render above other node types by @l5yth in <https://github.com/l5yth/potato-mesh/pull/169>
* Move lint checks after tests in CI by @l5yth in <https://github.com/l5yth/potato-mesh/pull/168>
* Handle proto values in nodeinfo payloads by @l5yth in <https://github.com/l5yth/potato-mesh/pull/167>
* Remove raw payload storage from database schema by @l5yth in <https://github.com/l5yth/potato-mesh/pull/166>
* Add POSITION_APP ingestion and API support by @l5yth in <https://github.com/l5yth/potato-mesh/pull/160>
* Add support for NODEINFO_APP packets by @l5yth in <https://github.com/l5yth/potato-mesh/pull/159>
* Derive SEO metadata from existing config values by @l5yth in <https://github.com/l5yth/potato-mesh/pull/153>
* Tests: create helper script to dump all mesh data from serial by @l5yth in <https://github.com/l5yth/potato-mesh/pull/152>
* Limit chat log to recent entries by @l5yth in <https://github.com/l5yth/potato-mesh/pull/151>
* Require time library before formatting ISO timestamps by @l5yth in <https://github.com/l5yth/potato-mesh/pull/149>
* Define docker compose network by @l5yth in <https://github.com/l5yth/potato-mesh/pull/148>
* Fix sqlite3 native extension on Alpine by @l5yth in <https://github.com/l5yth/potato-mesh/pull/146>
* Fix web app startup binding by @l5yth in <https://github.com/l5yth/potato-mesh/pull/147>
* Ensure sqlite3 builds from source on Alpine by @l5yth in <https://github.com/l5yth/potato-mesh/pull/145>
* Support mock serial interface in CI by @l5yth in <https://github.com/l5yth/potato-mesh/pull/143>
* Fix Docker workflow matrix for supported platforms by @l5yth in <https://github.com/l5yth/potato-mesh/pull/142>
* Add clickable role filters to the map legend by @l5yth in <https://github.com/l5yth/potato-mesh/pull/140>
* Rebuild chat log on each refresh by @l5yth in <https://github.com/l5yth/potato-mesh/pull/139>
* Fix: retain alpine runtime libs after removing build deps by @l5yth in <https://github.com/l5yth/potato-mesh/pull/138>
* Fix: support windows ingestor build by @l5yth in <https://github.com/l5yth/potato-mesh/pull/136>
* Fix: use supported ruby image by @l5yth in <https://github.com/l5yth/potato-mesh/pull/135>
* Feat: Add comprehensive Docker support by @trose in <https://github.com/l5yth/potato-mesh/pull/122>
* Chore: bump version to 0.2.1 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/134>
* Fix dark mode tile styling on new map tiles by @l5yth in <https://github.com/l5yth/potato-mesh/pull/132>
* Switch map tiles to OSM HOT and add theme filters by @l5yth in <https://github.com/l5yth/potato-mesh/pull/130>
* Add footer version display by @l5yth in <https://github.com/l5yth/potato-mesh/pull/128>
* Add responsive controls for map legend by @l5yth in <https://github.com/l5yth/potato-mesh/pull/129>
* Update changelog by @l5yth in <https://github.com/l5yth/potato-mesh/pull/119>

## v0.2.0

* Update readme for 0.2 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/118>
* Add PotatoMesh logo to header and favicon by @l5yth in <https://github.com/l5yth/potato-mesh/pull/117>
* Harden API auth and request limits by @l5yth in <https://github.com/l5yth/potato-mesh/pull/116>
* Add client-side sorting to node table by @l5yth in <https://github.com/l5yth/potato-mesh/pull/114>
* Add short name overlay for node details by @l5yth in <https://github.com/l5yth/potato-mesh/pull/111>
* Adjust python ingestor interval to 60 seconds by @l5yth in <https://github.com/l5yth/potato-mesh/pull/112>
* Hide location columns on medium screens by @l5yth in <https://github.com/l5yth/potato-mesh/pull/109>
* Handle message updates based on sender info by @l5yth in <https://github.com/l5yth/potato-mesh/pull/108>
* Prioritize node posts in queued API updates by @l5yth in <https://github.com/l5yth/potato-mesh/pull/107>
* Add auto-refresh toggle to UI by @l5yth in <https://github.com/l5yth/potato-mesh/pull/105>
* Adjust Leaflet popup styling for dark mode by @l5yth in <https://github.com/l5yth/potato-mesh/pull/104>
* Add site info overlay by @l5yth in <https://github.com/l5yth/potato-mesh/pull/103>
* Add long name tooltip to short name badge by @l5yth in <https://github.com/l5yth/potato-mesh/pull/102>
* Ensure node numeric aliases are derived from canonical IDs by @l5yth in <https://github.com/l5yth/potato-mesh/pull/101>
* Chore: clean up repository by @l5yth in <https://github.com/l5yth/potato-mesh/pull/96>
* Handle SQLite busy errors when upserting nodes by @l5yth in <https://github.com/l5yth/potato-mesh/pull/100>
* Configure Sinatra logging level from DEBUG flag by @l5yth in <https://github.com/l5yth/potato-mesh/pull/97>
* Add penetration tests for authentication and SQL injection by @l5yth in <https://github.com/l5yth/potato-mesh/pull/95>
* Document Python and Ruby source modules by @l5yth in <https://github.com/l5yth/potato-mesh/pull/94>
* Add tests covering mesh helper edge cases by @l5yth in <https://github.com/l5yth/potato-mesh/pull/93>
* Fix py code cov by @l5yth in <https://github.com/l5yth/potato-mesh/pull/92>
* Add Codecov reporting to Python CI by @l5yth in <https://github.com/l5yth/potato-mesh/pull/91>
* Skip null identifiers when selecting packet fields by @l5yth in <https://github.com/l5yth/potato-mesh/pull/88>
* Create python yml ga by @l5yth in <https://github.com/l5yth/potato-mesh/pull/90>
* Add unit tests for mesh ingestor script by @l5yth in <https://github.com/l5yth/potato-mesh/pull/89>
* Add coverage for debug logging on messages without sender by @l5yth in <https://github.com/l5yth/potato-mesh/pull/86>
* Handle concurrent node snapshot updates by @l5yth in <https://github.com/l5yth/potato-mesh/pull/85>
* Fix ingestion mapping for message sender IDs by @l5yth in <https://github.com/l5yth/potato-mesh/pull/84>
* Add coverage for API authentication and payload edge cases by @l5yth in <https://github.com/l5yth/potato-mesh/pull/83>
* Add JUnit test reporting to Ruby CI by @l5yth in <https://github.com/l5yth/potato-mesh/pull/82>
* Configure SimpleCov reporting for Codecov by @l5yth in <https://github.com/l5yth/potato-mesh/pull/81>
* Update codecov job by @l5yth in <https://github.com/l5yth/potato-mesh/pull/80>
* Fix readme badges by @l5yth in <https://github.com/l5yth/potato-mesh/pull/79>
* Add Codecov upload step to Ruby workflow by @l5yth in <https://github.com/l5yth/potato-mesh/pull/78>
* Add Apache license headers to source files by @l5yth in <https://github.com/l5yth/potato-mesh/pull/77>
* Add integration specs for node and message APIs by @l5yth in <https://github.com/l5yth/potato-mesh/pull/76>
* Docs: update for 0.2.0 release by @l5yth in <https://github.com/l5yth/potato-mesh/pull/75>
* Create ruby workflow by @l5yth in <https://github.com/l5yth/potato-mesh/pull/74>
* Add RSpec smoke tests for app boot and database init by @l5yth in <https://github.com/l5yth/potato-mesh/pull/73>
* Align refresh controls with status text by @l5yth in <https://github.com/l5yth/potato-mesh/pull/72>
* Improve mobile layout by @l5yth in <https://github.com/l5yth/potato-mesh/pull/68>
* Normalize message sender IDs using node numbers by @l5yth in <https://github.com/l5yth/potato-mesh/pull/67>
* Style: condense node table by @l5yth in <https://github.com/l5yth/potato-mesh/pull/65>
* Log debug details for messages without sender by @l5yth in <https://github.com/l5yth/potato-mesh/pull/64>
* Fix nested dataclass serialization for node snapshots by @l5yth in <https://github.com/l5yth/potato-mesh/pull/63>
* Log node object on snapshot update failure by @l5yth in <https://github.com/l5yth/potato-mesh/pull/62>
* Initialize database on startup by @l5yth in <https://github.com/l5yth/potato-mesh/pull/61>
* Send mesh data to Potatomesh API by @l5yth in <https://github.com/l5yth/potato-mesh/pull/60>
* Convert boolean flags for SQLite binding by @l5yth in <https://github.com/l5yth/potato-mesh/pull/59>
* Use packet id as message primary key by @l5yth in <https://github.com/l5yth/potato-mesh/pull/58>
* Add message ingestion API and stricter auth by @l5yth in <https://github.com/l5yth/potato-mesh/pull/56>
* Feat: parameterize community info by @l5yth in <https://github.com/l5yth/potato-mesh/pull/55>
* Feat: add dark mode toggle by @l5yth in <https://github.com/l5yth/potato-mesh/pull/54>

## v0.1.0

* Show daily node count in title and header by @l5yth in <https://github.com/l5yth/potato-mesh/pull/49>
* Add daily date separators to chat log by @l5yth in <https://github.com/l5yth/potato-mesh/pull/47>
* Feat: make frontend responsive for mobile by @l5yth in <https://github.com/l5yth/potato-mesh/pull/46>
* Harden mesh utilities by @l5yth in <https://github.com/l5yth/potato-mesh/pull/45>
* Filter out distant nodes from Berlin map view by @l5yth in <https://github.com/l5yth/potato-mesh/pull/43>
* Display filtered active node counts in #MediumFast subheading by @l5yth in <https://github.com/l5yth/potato-mesh/pull/44>
* Limit chat log and highlight short names by role by @l5yth in <https://github.com/l5yth/potato-mesh/pull/42>
* Fix string/integer comparison in node query by @l5yth in <https://github.com/l5yth/potato-mesh/pull/40>
* Escape chat message and node entries by @l5yth in <https://github.com/l5yth/potato-mesh/pull/39>
* Sort chat entries by timestamp by @l5yth in <https://github.com/l5yth/potato-mesh/pull/38>
* Feat: append messages to chat log by @l5yth in <https://github.com/l5yth/potato-mesh/pull/36>
* Normalize future timestamps for nodes by @l5yth in <https://github.com/l5yth/potato-mesh/pull/35>
* Optimize web frontend and Ruby app by @l5yth in <https://github.com/l5yth/potato-mesh/pull/32>
* Add messages API endpoint with node details by @l5yth in <https://github.com/l5yth/potato-mesh/pull/33>
* Clamp node timestamps and sync last_heard with position time by @l5yth in <https://github.com/l5yth/potato-mesh/pull/31>
* Refactor: replace deprecated utcfromtimestamp by @l5yth in <https://github.com/l5yth/potato-mesh/pull/30>
* Add optional debug logging for node and message operations by @l5yth in <https://github.com/l5yth/potato-mesh/pull/29>
* Data: enable serial collection of messages on channel 0 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/25>
* Add first_heard timestamp by @l5yth in <https://github.com/l5yth/potato-mesh/pull/23>
* Add persistent footer with contact information by @l5yth in <https://github.com/l5yth/potato-mesh/pull/22>
* Sort initial chat entries by last-heard by @l5yth in <https://github.com/l5yth/potato-mesh/pull/20>
* Display position time in relative 'time ago' format by @l5yth in <https://github.com/l5yth/potato-mesh/pull/19>
* Adjust marker size and map tile opacity by @l5yth in <https://github.com/l5yth/potato-mesh/pull/18>
* Add chat box for node notifications by @l5yth in <https://github.com/l5yth/potato-mesh/pull/17>
* Color markers by role with grayscale map by @l5yth in <https://github.com/l5yth/potato-mesh/pull/16>
* Default missing node role to client by @l5yth in <https://github.com/l5yth/potato-mesh/pull/15>
* Show live node count in nodes page titles by @l5yth in <https://github.com/l5yth/potato-mesh/pull/14>
* Filter stale nodes and add live search by @l5yth in <https://github.com/l5yth/potato-mesh/pull/13>
* Remove raw node JSON column by @l5yth in <https://github.com/l5yth/potato-mesh/pull/12>
* Add JSON ingest API for node updates by @l5yth in <https://github.com/l5yth/potato-mesh/pull/11>
* Ignore Python __pycache__ directories by @l5yth in <https://github.com/l5yth/potato-mesh/pull/10>
* Feat: load nodes from json for tests by @l5yth in <https://github.com/l5yth/potato-mesh/pull/8>
* Handle dataclass fields in node snapshots by @l5yth in <https://github.com/l5yth/potato-mesh/pull/6>
* Add index page and /nodes route for node map by @l5yth in <https://github.com/l5yth/potato-mesh/pull/4>
