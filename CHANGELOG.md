# CHANGELOG

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
