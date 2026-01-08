# CHANGELOG

## v0.5.9

* Matrix: listen for synapse on port 41448 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/607>
* Web: collapse federation map ledgend by @l5yth in <https://github.com/l5yth/potato-mesh/pull/604>
* Web: fix stale node queries by @l5yth in <https://github.com/l5yth/potato-mesh/pull/603>
* Matrix: move short name to display name by @l5yth in <https://github.com/l5yth/potato-mesh/pull/602>
* Ci: update ruby to 4 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/601>
* Web: display traces of last 28 days if available by @l5yth in <https://github.com/l5yth/potato-mesh/pull/599>
* Web: establish menu structure by @l5yth in <https://github.com/l5yth/potato-mesh/pull/597>
* Matrix: fixed the text-message checkpoint regression by @l5yth in <https://github.com/l5yth/potato-mesh/pull/595>
* Matrix: cache seen messages by rx_time not id by @l5yth in <https://github.com/l5yth/potato-mesh/pull/594>
* Web: hide the default '0' tab when not active by @l5yth in <https://github.com/l5yth/potato-mesh/pull/593>
* Matrix: fix empty bridge state json by @l5yth in <https://github.com/l5yth/potato-mesh/pull/592>
* Web: allow certain charts to overflow upper bounds by @l5yth in <https://github.com/l5yth/potato-mesh/pull/585>
* Ingestor: support ROUTING_APP messages by @l5yth in <https://github.com/l5yth/potato-mesh/pull/584>
* Ci: run nix flake check on ci by @l5yth in <https://github.com/l5yth/potato-mesh/pull/583>
* Web: hide legend by default by @l5yth in <https://github.com/l5yth/potato-mesh/pull/582>
* Nix flake by @benjajaja in <https://github.com/l5yth/potato-mesh/pull/577>
* Support BLE UUID format for macOS Bluetooth devices by @apo-mak in <https://github.com/l5yth/potato-mesh/pull/575>
* Web: add mesh.qrp.ro as seed node by @l5yth in <https://github.com/l5yth/potato-mesh/pull/573>
* Web: ensure unknown nodes for messages and traces by @l5yth in <https://github.com/l5yth/potato-mesh/pull/572>
* Chore: bump version to 0.5.9 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/569>

## v0.5.8

* Web: add secondary seed node jmrp.io by @l5yth in <https://github.com/l5yth/potato-mesh/pull/568>
* Data: implement whitelist for ingestor by @l5yth in <https://github.com/l5yth/potato-mesh/pull/567>
* Web: add ?since= parameter to all apis by @l5yth in <https://github.com/l5yth/potato-mesh/pull/566>
* Matrix: fix docker build by @l5yth in <https://github.com/l5yth/potato-mesh/pull/565>
* Matrix: fix docker build by @l5yth in <https://github.com/l5yth/potato-mesh/pull/564>
* Web: fix federation signature validation and create fallback by @l5yth in <https://github.com/l5yth/potato-mesh/pull/563>
* Chore: update readme by @l5yth in <https://github.com/l5yth/potato-mesh/pull/561>
* Matrix: add docker file for bridge by @l5yth in <https://github.com/l5yth/potato-mesh/pull/556>
* Matrix: add health checks to startup by @l5yth in <https://github.com/l5yth/potato-mesh/pull/555>
* Matrix: omit the api part in base url by @l5yth in <https://github.com/l5yth/potato-mesh/pull/554>
* App: add utility coverage tests for main.dart by @l5yth in <https://github.com/l5yth/potato-mesh/pull/552>
* Data: add thorough daemon unit tests by @l5yth in <https://github.com/l5yth/potato-mesh/pull/553>
* Chore: bump version to 0.5.8 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/551>

## v0.5.7

* Data: track ingestors heartbeat by @l5yth in <https://github.com/l5yth/potato-mesh/pull/549>
* Harden instance selector navigation URLs by @l5yth in <https://github.com/l5yth/potato-mesh/pull/550>
* Data: hide channels that have been flag for ignoring by @l5yth in <https://github.com/l5yth/potato-mesh/pull/548>
* Web: fix limit when counting remote nodes by @l5yth in <https://github.com/l5yth/potato-mesh/pull/547>
* Web: improve instances map and table view by @l5yth in <https://github.com/l5yth/potato-mesh/pull/546>
* Web: fix traces submission with optional fields on udp by @l5yth in <https://github.com/l5yth/potato-mesh/pull/545>
* Chore: bump version to 0.5.7 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/542>
* Handle zero telemetry aggregates by @l5yth in <https://github.com/l5yth/potato-mesh/pull/538>
* Web: fix telemetry api to return current in amperes by @l5yth in <https://github.com/l5yth/potato-mesh/pull/541>
* Web: fix traces rendering by @l5yth in <https://github.com/l5yth/potato-mesh/pull/535>
* Normalize numeric node roles to canonical labels by @l5yth in <https://github.com/l5yth/potato-mesh/pull/539>
* Use INSTANCE_DOMAIN env for ingestor by @l5yth in <https://github.com/l5yth/potato-mesh/pull/536>
* Web: further refine the federation page by @l5yth in <https://github.com/l5yth/potato-mesh/pull/534>
* Add Federation Map by @apo-mak in <https://github.com/l5yth/potato-mesh/pull/532>
* Add contact link to the instance data by @apo-mak in <https://github.com/l5yth/potato-mesh/pull/533>
* Matrix: create potato-matrix-bridge by @l5yth in <https://github.com/l5yth/potato-mesh/pull/528>

## v0.5.6

* Web: display sats in view by @l5yth in <https://github.com/l5yth/potato-mesh/pull/523>
* Web: display air quality in separate chart by @l5yth in <https://github.com/l5yth/potato-mesh/pull/521>
* Ci: Add macOS and Ubuntu builds to Flutter workflow by @l5yth in <https://github.com/l5yth/potato-mesh/pull/519>
* Web: add current to charts by @l5yth in <https://github.com/l5yth/potato-mesh/pull/520>
* App: fix notification icon by @l5yth in <https://github.com/l5yth/potato-mesh/pull/518>
* Spec: update test fixtures by @l5yth in <https://github.com/l5yth/potato-mesh/pull/517>
* App: generate proper icons by @l5yth in <https://github.com/l5yth/potato-mesh/pull/516>
* Web: fix favicon by @l5yth in <https://github.com/l5yth/potato-mesh/pull/515>
* Web: add ?since= parameter to api/messages by @l5yth in <https://github.com/l5yth/potato-mesh/pull/512>
* App: implement notifications by @l5yth in <https://github.com/l5yth/potato-mesh/pull/511>
* App: add theme selector by @l5yth in <https://github.com/l5yth/potato-mesh/pull/507>
* App: further harden refresh logic and prefer local first by @l5yth in <https://github.com/l5yth/potato-mesh/pull/506>
* Ci: fix app artifacts for tags by @l5yth in <https://github.com/l5yth/potato-mesh/pull/504>
* Ci: build app artifacts for tags by @l5yth in <https://github.com/l5yth/potato-mesh/pull/503>
* App: add persistance by @l5yth in <https://github.com/l5yth/potato-mesh/pull/501>
* App: instance and chat mvp by @l5yth in <https://github.com/l5yth/potato-mesh/pull/498>
* App: add instance selector to settings by @l5yth in <https://github.com/l5yth/potato-mesh/pull/497>
* App: add scaffholding gitignore by @l5yth in <https://github.com/l5yth/potato-mesh/pull/496>
* Handle reaction app packets without reply id by @l5yth in <https://github.com/l5yth/potato-mesh/pull/495>
* Render reaction multiplier counts by @l5yth in <https://github.com/l5yth/potato-mesh/pull/494>
* Add comprehensive tests for Flutter reader by @l5yth in <https://github.com/l5yth/potato-mesh/pull/491>
* Map numeric role ids to canonical Meshtastic roles by @l5yth in <https://github.com/l5yth/potato-mesh/pull/489>
* Update node detail hydration for traces by @l5yth in <https://github.com/l5yth/potato-mesh/pull/490>
* Add mobile Flutter CI workflow by @l5yth in <https://github.com/l5yth/potato-mesh/pull/488>
* Align OCI labels in docker workflow by @l5yth in <https://github.com/l5yth/potato-mesh/pull/487>
* Add Meshtastic reader Flutter app by @l5yth in <https://github.com/l5yth/potato-mesh/pull/483>
* Handle pre-release Docker tagging by @l5yth in <https://github.com/l5yth/potato-mesh/pull/486>
* Web: remove range from charts labels by @l5yth in <https://github.com/l5yth/potato-mesh/pull/485>
* Floor override frequencies to MHz integers by @l5yth in <https://github.com/l5yth/potato-mesh/pull/476>
* Prevent message ids from being treated as node identifiers by @l5yth in <https://github.com/l5yth/potato-mesh/pull/475>
* Fix 1 after emojis in reply. by @Alexkurd in <https://github.com/l5yth/potato-mesh/pull/464>
* Add frequency and preset to node table by @l5yth in <https://github.com/l5yth/potato-mesh/pull/472>
* Subscribe to traceroute app pubsub topic by @l5yth in <https://github.com/l5yth/potato-mesh/pull/471>
* Aggregate telemetry over the last 7 days by @l5yth in <https://github.com/l5yth/potato-mesh/pull/470>
* Address missing id field ingestor bug by @l5yth in <https://github.com/l5yth/potato-mesh/pull/469>
* Merge secondary channels by name by @l5yth in <https://github.com/l5yth/potato-mesh/pull/468>
* Rate limit host device telemetry by @l5yth in <https://github.com/l5yth/potato-mesh/pull/467>
* Add traceroutes to frontend by @l5yth in <https://github.com/l5yth/potato-mesh/pull/466>
* Feat: implement traceroute app packet handling across the stack by @l5yth in <https://github.com/l5yth/potato-mesh/pull/463>
* Bump version and update changelog by @l5yth in <https://github.com/l5yth/potato-mesh/pull/462>

## v0.5.5

* Added comprehensive helper unit tests by @l5yth in <https://github.com/l5yth/potato-mesh/pull/457>
* Added reaction-aware handling by @l5yth in <https://github.com/l5yth/potato-mesh/pull/455>
* Env: add map zoom by @l5yth in <https://github.com/l5yth/potato-mesh/pull/454>
* Charts: render aggregated telemetry charts for all nodes by @l5yth in <https://github.com/l5yth/potato-mesh/pull/453>
* Nodes: render charts detail pages as overlay by @l5yth in <https://github.com/l5yth/potato-mesh/pull/452>
* Fix telemetry parsing for charts by @l5yth in <https://github.com/l5yth/potato-mesh/pull/451>
* Nodes: improve charts on detail pages by @l5yth in <https://github.com/l5yth/potato-mesh/pull/450>
* Nodes: add charts to detail pages by @l5yth in <https://github.com/l5yth/potato-mesh/pull/449>
* Aggregate frontend snapshots across views by @l5yth in <https://github.com/l5yth/potato-mesh/pull/447>
* Remove added 1 if reply with emoji by @Alexkurd in <https://github.com/l5yth/potato-mesh/pull/443>
* Refine node detail view layout by @l5yth in <https://github.com/l5yth/potato-mesh/pull/442>
* Enable map centering from node table coordinates by @l5yth in <https://github.com/l5yth/potato-mesh/pull/439>
* Add node detail route and page by @l5yth in <https://github.com/l5yth/potato-mesh/pull/441>
* Ensure Meshtastic nodeinfo patch runs before importing interfaces by @l5yth in <https://github.com/l5yth/potato-mesh/pull/440>
* Filter zero-valued fields from API responses by @l5yth in <https://github.com/l5yth/potato-mesh/pull/438>
* Add debug payload tracing and ignored packet logging by @l5yth in <https://github.com/l5yth/potato-mesh/pull/437>
* Tighten map auto-fit behaviour by @l5yth in <https://github.com/l5yth/potato-mesh/pull/435>
* Fetch encrypted chat log entries for log tab by @l5yth in <https://github.com/l5yth/potato-mesh/pull/434>
* Add encrypted filter to messages API by @l5yth in <https://github.com/l5yth/potato-mesh/pull/432>
* Guard NodeInfo handler against missing IDs by @l5yth in <https://github.com/l5yth/potato-mesh/pull/431>
* Add standalone full-screen map, chat, and nodes views by @l5yth in <https://github.com/l5yth/potato-mesh/pull/429>
* Ensure chat history fetches full message limit by @l5yth in <https://github.com/l5yth/potato-mesh/pull/428>
* Fix ingestion of nodeinfo packets missing ids (#426) by @l5yth in <https://github.com/l5yth/potato-mesh/pull/427>
* Chore: update license headers by @l5yth in <https://github.com/l5yth/potato-mesh/pull/424>
* Chore: bump version to 0.5.5 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/423>

## v0.5.4

* Handle naming when primary channel has a name by @l5yth in <https://github.com/l5yth/potato-mesh/pull/422>
* Handle edge case when primary channel has a name by @l5yth in <https://github.com/l5yth/potato-mesh/pull/421>
* Add preset mode to logs by @l5yth in <https://github.com/l5yth/potato-mesh/pull/420>
* Parallelize federation tasks with worker pool by @l5yth in <https://github.com/l5yth/potato-mesh/pull/419>
* Allow filtering chat and logs by node name by @l5yth in <https://github.com/l5yth/potato-mesh/pull/417>
* Gem: Add erb as dependency removed from std by @l5yth in <https://github.com/l5yth/potato-mesh/pull/416>
* Implement support for replies and reactions app by @l5yth in <https://github.com/l5yth/potato-mesh/pull/411>
* Ingestor: Ignore direct messages on default channel by @l5yth in <https://github.com/l5yth/potato-mesh/pull/414>
* Agents: Add instructions by @l5yth in <https://github.com/l5yth/potato-mesh/pull/410>
* Display encrypted messages in frontend log window by @l5yth in <https://github.com/l5yth/potato-mesh/pull/409>
* Add chat log entries for telemetry, position, and neighbor events by @l5yth in <https://github.com/l5yth/potato-mesh/pull/408>
* Handle missing instance domain outside production by @l5yth in <https://github.com/l5yth/potato-mesh/pull/405>
* Add tabbed chat panel with channel grouping by @l5yth in <https://github.com/l5yth/potato-mesh/pull/404>
* Normalize numeric client roles using Meshtastic CLI enums by @l5yth in <https://github.com/l5yth/potato-mesh/pull/402>
* Ensure Docker images publish versioned tags by @l5yth in <https://github.com/l5yth/potato-mesh/pull/403>
* Document environment configuration variables by @l5yth in <https://github.com/l5yth/potato-mesh/pull/400>
* Document federation refresh cadence by @l5yth in <https://github.com/l5yth/potato-mesh/pull/401>
* Add Prometheus monitoring documentation by @l5yth in <https://github.com/l5yth/potato-mesh/pull/399>
* Config: Read PROM_REPORT_IDS from environment by @nicjansma in <https://github.com/l5yth/potato-mesh/pull/398>
* Feat: Mesh-Ingestor: Ability to provide already-existing interface instance by @KenADev in <https://github.com/l5yth/potato-mesh/pull/395>
* Fix: Mesh-Ingestor: Fix error for non-existing datetime.UTC reference by @KenADev in <https://github.com/l5yth/potato-mesh/pull/396>
* Chore: bump version to 0.5.4 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/388>

## v0.5.3

* Add telemetry formatting utilities and extend node overlay by @l5yth in <https://github.com/l5yth/potato-mesh/pull/387>
* Prune blank values from API responses by @l5yth in <https://github.com/l5yth/potato-mesh/pull/386>
* Add full support to telemetry schema and API by @l5yth in <https://github.com/l5yth/potato-mesh/pull/385>
* Respect PORT environment override by @l5yth in <https://github.com/l5yth/potato-mesh/pull/384>
* Add instance selector dropdown for federation deployments by @l5yth in <https://github.com/l5yth/potato-mesh/pull/382>
* Harden federation announcements by @l5yth in <https://github.com/l5yth/potato-mesh/pull/381>
* Ensure private mode disables federation by @l5yth in <https://github.com/l5yth/potato-mesh/pull/380>
* Ensure private mode disables chat messaging by @l5yth in <https://github.com/l5yth/potato-mesh/pull/378>
* Disable federation features when FEDERATION=0 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/379>
* Expose PRIVATE environment configuration across tooling by @l5yth in <https://github.com/l5yth/potato-mesh/pull/377>
* Fix frontend coverage export for Codecov by @l5yth in <https://github.com/l5yth/potato-mesh/pull/376>
* Restrict /api/instances results to recent records by @l5yth in <https://github.com/l5yth/potato-mesh/pull/374>
* Expose FEDERATION environment option across tooling by @l5yth in <https://github.com/l5yth/potato-mesh/pull/375>
* Chore: bump version to 0.5.3 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/372>

## v0.5.2

* Align theme and info controls by @l5yth in <https://github.com/l5yth/potato-mesh/pull/371>
* Fixes POST request 403 errors on instances behind Cloudflare proxy by @varna9000 in <https://github.com/l5yth/potato-mesh/pull/368>
* Delay initial federation announcements by @l5yth in <https://github.com/l5yth/potato-mesh/pull/366>
* Ensure well-known document stays in sync on startup by @l5yth in <https://github.com/l5yth/potato-mesh/pull/365>
* Guard federation DNS resolution against restricted networks by @l5yth in <https://github.com/l5yth/potato-mesh/pull/362>
* Add federation ingestion limits and tests by @l5yth in <https://github.com/l5yth/potato-mesh/pull/364>
* Prefer reported primary channel names by @l5yth in <https://github.com/l5yth/potato-mesh/pull/363>
* Decouple message API node hydration by @l5yth in <https://github.com/l5yth/potato-mesh/pull/360>
* Fix ingestor reconnection detection by @l5yth in <https://github.com/l5yth/potato-mesh/pull/361>
* Harden instance domain validation by @l5yth in <https://github.com/l5yth/potato-mesh/pull/359>
* Ensure INSTANCE_DOMAIN propagates to containers by @l5yth in <https://github.com/l5yth/potato-mesh/pull/358>
* Chore: bump version to 0.5.2 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/356>
* Gracefully retry federation announcements over HTTP by @l5yth in <https://github.com/l5yth/potato-mesh/pull/355>

## v0.5.1

* Recursively ingest federated instances by @l5yth in <https://github.com/l5yth/potato-mesh/pull/353>
* Remove federation timeout environment overrides by @l5yth in <https://github.com/l5yth/potato-mesh/pull/352>
* Close unrelated short info overlays when opening short info by @l5yth in <https://github.com/l5yth/potato-mesh/pull/351>
* Improve federation instance error diagnostics by @l5yth in <https://github.com/l5yth/potato-mesh/pull/350>
* Harden federation domain validation and tests by @l5yth in <https://github.com/l5yth/potato-mesh/pull/347>
* Handle malformed instance records gracefully by @l5yth in <https://github.com/l5yth/potato-mesh/pull/348>
* Fix ingestor device mounting for non-serial connections by @l5yth in <https://github.com/l5yth/potato-mesh/pull/346>
* Ensure Docker deployments persist keyfile and well-known assets by @l5yth in <https://github.com/l5yth/potato-mesh/pull/345>
* Add modem preset display to node overlay by @l5yth in <https://github.com/l5yth/potato-mesh/pull/340>
* Display message frequency and channel in chat log by @l5yth in <https://github.com/l5yth/potato-mesh/pull/339>
* Bump fallback version string to v0.5.1 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/338>
* Docs: update changelog for 0.5.0 by @l5yth in <https://github.com/l5yth/potato-mesh/pull/337>
* Fix ingestor docker import path by @l5yth in <https://github.com/l5yth/potato-mesh/pull/336>

## v0.5.0

* Ensure node overlays appear above fullscreen map by @l5yth in <https://github.com/l5yth/potato-mesh/pull/333>
* Adjust node table columns responsively by @l5yth in <https://github.com/l5yth/potato-mesh/pull/332>
* Add LoRa metadata fields to nodes and messages by @l5yth in <https://github.com/l5yth/potato-mesh/pull/331>
* Add channel metadata capture for message tagging by @l5yth in <https://github.com/l5yth/potato-mesh/pull/329>
* Capture radio metadata for ingestor payloads by @l5yth in <https://github.com/l5yth/potato-mesh/pull/327>
* Fix FrozenError when filtering node query results by @l5yth in <https://github.com/l5yth/potato-mesh/pull/324>
* Ensure frontend reports git-aware version strings by @l5yth in <https://github.com/l5yth/potato-mesh/pull/321>
* Ensure web Docker image ships application sources by @l5yth in <https://github.com/l5yth/potato-mesh/pull/322>
* Refine stacked short info overlays on the map by @l5yth in <https://github.com/l5yth/potato-mesh/pull/319>
* Refine environment configuration defaults by @l5yth in <https://github.com/l5yth/potato-mesh/pull/318>
* Fix legacy configuration migration to XDG directories by @l5yth in <https://github.com/l5yth/potato-mesh/pull/317>
* Adopt XDG base directories for app data and config by @l5yth in <https://github.com/l5yth/potato-mesh/pull/316>
* Refactor: streamline ingestor environment variables by @l5yth in <https://github.com/l5yth/potato-mesh/pull/314>
* Adjust map auto-fit padding and default zoom by @l5yth in <https://github.com/l5yth/potato-mesh/pull/315>
* Ensure APIs filter stale data and refresh node details from latest sources by @l5yth in <https://github.com/l5yth/potato-mesh/pull/312>
* Improve offline tile fallback initialization by @l5yth in <https://github.com/l5yth/potato-mesh/pull/307>
* Add fallback for offline tile rendering errors by @l5yth in <https://github.com/l5yth/potato-mesh/pull/306>
* Fix map auto-fit handling and add controller by @l5yth in <https://github.com/l5yth/potato-mesh/pull/311>
* Fix map initialization bounds and add coverage by @l5yth in <https://github.com/l5yth/potato-mesh/pull/305>
* Increase coverage for configuration and sanitizer helpers by @l5yth in <https://github.com/l5yth/potato-mesh/pull/303>
* Add comprehensive theme and background front-end tests by @l5yth in <https://github.com/l5yth/potato-mesh/pull/302>
* Document sanitization and helper modules by @l5yth in <https://github.com/l5yth/potato-mesh/pull/301>
* Add in-repo Meshtastic protobuf stubs for tests by @l5yth in <https://github.com/l5yth/potato-mesh/pull/300>
* Handle CRL lookup failures during federation TLS by @l5yth in <https://github.com/l5yth/potato-mesh/pull/299>
* Ensure JavaScript workflow runs frontend tests by @l5yth in <https://github.com/l5yth/potato-mesh/pull/298>
* Unify structured logging across application and ingestor by @l5yth in <https://github.com/l5yth/potato-mesh/pull/296>
* Add Apache license headers to missing sources by @l5yth in <https://github.com/l5yth/potato-mesh/pull/297>
* Update workflows for ingestor, sinatra, and frontend by @l5yth in <https://github.com/l5yth/potato-mesh/pull/295>
* Fix IPv6 instance domain canonicalization by @l5yth in <https://github.com/l5yth/potato-mesh/pull/294>
* Handle federation HTTPS CRL verification failures by @l5yth in <https://github.com/l5yth/potato-mesh/pull/293>
* Adjust federation announcement interval to eight hours by @l5yth in <https://github.com/l5yth/potato-mesh/pull/292>
* Restore modular app functionality by @l5yth in <https://github.com/l5yth/potato-mesh/pull/291>
* Refactor config and metadata helpers into PotatoMesh modules by @l5yth in <https://github.com/l5yth/potato-mesh/pull/290>
* Update default site configuration defaults by @l5yth in <https://github.com/l5yth/potato-mesh/pull/288>
* Add regression test for queue drain concurrency by @l5yth in <https://github.com/l5yth/potato-mesh/pull/287>
* Ensure Docker config directories are created for non-root user by @l5yth in <https://github.com/l5yth/potato-mesh/pull/286>
* Clarify numeric address requirement for network target parsing by @l5yth in <https://github.com/l5yth/potato-mesh/pull/285>
* Ensure mesh ingestor queue resets active flag when idle by @l5yth in <https://github.com/l5yth/potato-mesh/pull/284>
* Clarify BLE connection description in README by @l5yth in <https://github.com/l5yth/potato-mesh/pull/283>
* Configure web container for production mode by @l5yth in <https://github.com/l5yth/potato-mesh/pull/282>
* Normalize INSTANCE_DOMAIN configuration to require hostnames by @l5yth in <https://github.com/l5yth/potato-mesh/pull/280>
* Avoid blocking startup on federation announcements by @l5yth in <https://github.com/l5yth/potato-mesh/pull/281>
* Fix production Docker builds for web and ingestor images by @l5yth in <https://github.com/l5yth/potato-mesh/pull/279>
* Improve instance domain detection logic by @l5yth in <https://github.com/l5yth/potato-mesh/pull/278>
* Implement federation announcements and instances API by @l5yth in <https://github.com/l5yth/potato-mesh/pull/277>
* Fix federation signature handling and IP guard by @l5yth in <https://github.com/l5yth/potato-mesh/pull/276>
* Add persistent federation metadata endpoint by @l5yth in <https://github.com/l5yth/potato-mesh/pull/274>
* Add configurable instance domain with reverse DNS fallback by @l5yth in <https://github.com/l5yth/potato-mesh/pull/272>
* Document production deployment configuration by @l5yth in <https://github.com/l5yth/potato-mesh/pull/273>
* Add targeted API endpoints and expose version metadata by @l5yth in <https://github.com/l5yth/potato-mesh/pull/271>
* Prometheus metrics updates on startup and for position/telemetry by @nicjansma in <https://github.com/l5yth/potato-mesh/pull/270>
* Add hourly reconnect handling for inactive mesh interface by @l5yth in <https://github.com/l5yth/potato-mesh/pull/267>
* Dockerfile fixes by @nicjansma in <https://github.com/l5yth/potato-mesh/pull/268>
* Added prometheus /metrics endpoint by @nicjansma in <https://github.com/l5yth/potato-mesh/pull/262>
* Add fullscreen toggle to map view by @l5yth in <https://github.com/l5yth/potato-mesh/pull/263>
* Relocate JS coverage export script into web directory by @l5yth in <https://github.com/l5yth/potato-mesh/pull/266>
* V0.4.0 version string in web UI by @nicjansma in <https://github.com/l5yth/potato-mesh/pull/265>
* Add energy saving cycle to ingestor daemon by @l5yth in <https://github.com/l5yth/potato-mesh/pull/256>
* Chore: restore apache headers by @l5yth in <https://github.com/l5yth/potato-mesh/pull/260>
* Docs: add matrix to readme by @l5yth in <https://github.com/l5yth/potato-mesh/pull/259>
* Force dark theme default based on sanitized cookie by @l5yth in <https://github.com/l5yth/potato-mesh/pull/252>
* Document mesh ingestor modules with PDoc-style docstrings by @l5yth in <https://github.com/l5yth/potato-mesh/pull/255>
* Handle missing node IDs in Meshtastic nodeinfo packets by @l5yth in <https://github.com/l5yth/potato-mesh/pull/251>
* Document Ruby helper methods with RDoc comments by @l5yth in <https://github.com/l5yth/potato-mesh/pull/254>
* Add JSDoc documentation across client scripts by @l5yth in <https://github.com/l5yth/potato-mesh/pull/253>
* Fix mesh ingestor telemetry and neighbor handling by @l5yth in <https://github.com/l5yth/potato-mesh/pull/249>
* Refactor front-end assets into external modules by @l5yth in <https://github.com/l5yth/potato-mesh/pull/245>
* Add tests for helper utilities and asset routes by @l5yth in <https://github.com/l5yth/potato-mesh/pull/243>
* Docs: add ingestor inline docstrings by @l5yth in <https://github.com/l5yth/potato-mesh/pull/244>
* Add comprehensive coverage tests for mesh ingestor by @l5yth in <https://github.com/l5yth/potato-mesh/pull/241>
* Add inline documentation to config helpers and frontend scripts by @l5yth in <https://github.com/l5yth/potato-mesh/pull/240>
* Update changelog by @l5yth in <https://github.com/l5yth/potato-mesh/pull/238>

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
