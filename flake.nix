# Copyright © 2025-26 l5yth & contributors
# Licensed under the Apache License, Version 2.0 (see LICENSE)
{
  description = "PotatoMesh - A federated, Meshtastic-powered node dashboard";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Python environment for the ingestor
        pythonEnv = pkgs.python3.withPackages (ps: with ps; [
          meshtastic
          protobuf
          requests
        ]);

        # Web app wrapper script
        webApp = pkgs.writeShellApplication {
          name = "potato-mesh-web";
          runtimeInputs = [ pkgs.ruby pkgs.bundler pkgs.sqlite pkgs.git pkgs.gnumake pkgs.gcc ];
          text = ''
            if [ -n "''${XDG_DATA_HOME:-}" ]; then
              BASEDIR="$XDG_DATA_HOME"
            else
              BASEDIR="$HOME/.local/share/potato-mesh"
            fi
            WORKDIR="$BASEDIR/web"
            mkdir -p "$WORKDIR"

            # Copy app files if not present or outdated
            APP_SRC="${./web}"
            DATA_SRC="${./data}"
            if [ ! -f "$WORKDIR/.installed" ] || [ "$APP_SRC" != "$(cat "$WORKDIR/.src_path" 2>/dev/null)" ]; then
              # Copy web app
              cp -rT "$APP_SRC" "$WORKDIR/"
              chmod -R u+w "$WORKDIR"
              # Copy data directory (contains SQL schemas)
              mkdir -p "$BASEDIR/data"
              cp -rT "$DATA_SRC" "$BASEDIR/data/"
              chmod -R u+w "$BASEDIR/data"
              echo "$APP_SRC" > "$WORKDIR/.src_path"
              rm -f "$WORKDIR/.installed"
            fi

            cd "$WORKDIR"

            # Install gems if needed
            if [ ! -f ".installed" ]; then
              bundle config set --local path 'vendor/bundle'
              bundle install
              touch .installed
            fi

            exec bundle exec ruby app.rb -p "''${PORT:-41447}" -o "''${HOST:-0.0.0.0}"
          '';
        };

        # Ingestor wrapper script
        ingestor = pkgs.writeShellApplication {
          name = "potato-mesh-ingestor";
          runtimeInputs = [ pythonEnv ];
          text = ''
            # The ingestor needs to run from parent directory with data/ folder
            if [ -n "''${XDG_DATA_HOME:-}" ]; then
              BASEDIR="$XDG_DATA_HOME"
            else
              BASEDIR="$HOME/.local/share/potato-mesh"
            fi
            if [ ! -d "$BASEDIR/data" ]; then
              mkdir -p "$BASEDIR"
              cp -rT "${./data}" "$BASEDIR/data/"
              chmod -R u+w "$BASEDIR/data"
            fi
            cd "$BASEDIR"
            exec python -m data.mesh
          '';
        };

      in {
        packages = {
          web = webApp;
          ingestor = ingestor;
          default = webApp;
        };

        apps = {
          web = {
            type = "app";
            program = "${webApp}/bin/potato-mesh-web";
          };
          ingestor = {
            type = "app";
            program = "${ingestor}/bin/potato-mesh-ingestor";
          };
          default = self.apps.${system}.web;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.ruby
            pkgs.bundler
            pythonEnv
            pkgs.sqlite
          ];

          shellHook = ''
            echo "PotatoMesh development shell"
            echo "  - Ruby: $(ruby --version)"
            echo "  - Python: $(python --version)"
            echo ""
            echo "To run the web app:  cd web && bundle install && ./app.sh"
            echo "To run the ingestor: cd data && python mesh.py"
          '';
        };

        checks.potato-mesh-nixos = pkgs.testers.nixosTest {
          name = "potato-mesh-data-dir";
          nodes.machine = { lib, ... }: {
            imports = [ self.nixosModules.default ];
            services.potato-mesh = {
              enable = true;
              apiToken = "test-token";
              dataDir = "/var/lib/potato-mesh";
              ingestor.enable = true;
            };
            systemd.services.potato-mesh-ingestor.wantedBy = lib.mkForce [];
          };
          testScript = ''
            machine.start
            machine.succeed("grep -q 'XDG_DATA_HOME=/var/lib/potato-mesh' /etc/systemd/system/potato-mesh-web.service")
            machine.succeed("grep -q 'XDG_DATA_HOME=/var/lib/potato-mesh' /etc/systemd/system/potato-mesh-ingestor.service")
            machine.succeed("grep -q 'WorkingDirectory=/var/lib/potato-mesh' /etc/systemd/system/potato-mesh-web.service")
            machine.succeed("grep -q 'WorkingDirectory=/var/lib/potato-mesh' /etc/systemd/system/potato-mesh-ingestor.service")
          '';
        };
      }
    ) // {
      # NixOS module
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.potato-mesh;
        in {
          options.services.potato-mesh = {
            enable = lib.mkEnableOption "PotatoMesh web dashboard";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.web;
              description = "The potato-mesh web package to use";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 41447;
              description = "Port to listen on";
            };

            host = lib.mkOption {
              type = lib.types.str;
              default = "0.0.0.0";
              description = "Host to bind to";
            };

            apiToken = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Shared secret that authorizes ingestors and API clients making POST requests. Warning: visible in nix store. Prefer apiTokenFile for production.";
            };

            apiTokenFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = "File containing API_TOKEN=<secret> (recommended for production)";
            };

            instanceDomain = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Public hostname used for metadata, federation, and generated API links";
            };

            siteName = lib.mkOption {
              type = lib.types.str;
              default = "PotatoMesh Demo";
              description = "Title and header displayed in the UI";
            };

            channel = lib.mkOption {
              type = lib.types.str;
              default = "#LongFast";
              description = "Default channel name displayed in the UI";
            };

            frequency = lib.mkOption {
              type = lib.types.str;
              default = "915MHz";
              description = "Default frequency description displayed in the UI";
            };

            contactLink = lib.mkOption {
              type = lib.types.str;
              default = "#potatomesh:dod.ngo";
              description = "Chat link or Matrix alias rendered in the footer and overlays";
            };

            mapCenter = lib.mkOption {
              type = lib.types.str;
              default = "38.761944,-27.090833";
              description = "Latitude and longitude that centre the map on load";
            };

            mapZoom = lib.mkOption {
              type = lib.types.nullOr lib.types.int;
              default = null;
              description = "Fixed Leaflet zoom applied on first load; disables auto-fit when provided";
            };

            maxDistance = lib.mkOption {
              type = lib.types.int;
              default = 42;
              description = "Maximum distance (km) before node relationships are hidden on the map";
            };

            debug = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Enable verbose logging";
            };

            allowedChannels = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Comma-separated channel names the ingestor accepts";
            };

            hiddenChannels = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Comma-separated channel names the ingestor will ignore";
            };

            federation = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Announce instance and crawl peers";
            };

            private = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Hide chat UI, disable message APIs, and exclude hidden clients from public listings";
            };

            dataDir = lib.mkOption {
              type = lib.types.path;
              default = "/var/lib/potato-mesh";
              description = "Directory to store database and configuration";
            };

            user = lib.mkOption {
              type = lib.types.str;
              default = "potato-mesh";
              description = "User to run the service as";
            };

            group = lib.mkOption {
              type = lib.types.str;
              default = "potato-mesh";
              description = "Group to run the service as";
            };

            announcement = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Announcement banner text rendered above the header on every page";
            };

            ogImageUrl = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Absolute http(s) URL for the social preview image, replacing the generated /og-image.png";
            };

            pagesDir = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Directory of static custom-content pages served at /pages/:slug";
            };

            promReportIds = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Comma-separated node ids exported as per-node Prometheus gauges";
            };

            events = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Serve the live-update SSE stream at /api/events; when false clients poll instead";
            };

            meshtasticPreset = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Meshtastic radio preset for the join strip; overrides the deprecated channel option";
            };

            meshtasticFreq = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Meshtastic frequency for the join strip; overrides the deprecated frequency option";
            };

            meshcorePreset = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Meshcore radio preset; the join strip hides the Meshcore line until both Meshcore values are set";
            };

            meshcoreFreq = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Meshcore frequency; the join strip hides the Meshcore line until both Meshcore values are set";
            };

            # Ingestor options
            ingestor = {
              enable = lib.mkEnableOption "PotatoMesh Python ingestor";

              package = lib.mkOption {
                type = lib.types.package;
                default = self.packages.${pkgs.system}.ingestor;
                description = "The potato-mesh ingestor package to use";
              };

              connection = lib.mkOption {
                type = lib.types.str;
                default = "/dev/ttyACM0";
                description = "Connection target: serial port, IP:port for TCP, or Bluetooth address for BLE";
              };

              protocol = lib.mkOption {
                type = lib.types.enum [ "meshtastic" "meshcore" "reticulum" ];
                default = "meshtastic";
                description = "Mesh protocol the ingestor reads";
              };

              transport = lib.mkOption {
                type = lib.types.enum [ "api" "udp" ];
                default = "api";
                description = "Meshtastic transport: api (serial/TCP/BLE) or udp (passive LAN multicast)";
              };

              nodeId = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Host node id for the ingestor heartbeat; required for transport=udp, optional for protocol=reticulum";
              };

              channelIndex = lib.mkOption {
                type = lib.types.int;
                default = 0;
                description = "Channel index to ingest from";
              };

              energySaving = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = "Sleep between ingestion cycles instead of holding the connection open";
              };

              reticulumConfigDir = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "RNS config directory for protocol=reticulum; defaults to ~/.reticulum. Point it at the directory rnsd uses so interface filtering resolves names";
              };

              reticulumInterfaces = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Comma-separated case-insensitive substrings of RNS interface names to ingest from; null ingests from every interface";
              };

              primaryChannelOnly = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = "Ingest only channel 0. Unconditional when transport=udp; this option affects the api transport only";
              };

              primaryChannelKey = lib.mkOption {
                type = lib.types.str;
                default = "AQ==";
                description = "Base64 primary-channel PSK (Meshtastic default shown)";
              };

              primaryChannelName = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Name of channel 0, as shown by `meshtastic --info`. Required when transport=udp with primaryChannelOnly: it resolves the channel hash, and without it UDP mode drops all traffic (fail closed)";
              };

              meshUdpGroup = lib.mkOption {
                type = lib.types.str;
                default = "224.0.0.69";
                description = "Multicast group for Meshtastic \"Mesh via UDP\"";
              };

              meshUdpPort = lib.mkOption {
                type = lib.types.port;
                default = 4403;
                description = "Multicast port for Meshtastic \"Mesh via UDP\"";
              };

              meshcoreSelfTelemetrySeconds = lib.mkOption {
                type = lib.types.int;
                default = 3600;
                description = "Seconds between Meshcore host self-telemetry reads over the companion link (no airtime); 0 disables";
              };

              meshcoreTelemetryPollSeconds = lib.mkOption {
                type = lib.types.int;
                default = 300;
                description = "Seconds between Meshcore contact telemetry polls; requires txEnabled since polling transmits. 0 disables on-air polling";
              };

              txEnabled = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  Allow the ingestor to transmit on the mesh. Off by default: the
                  ingestor is a listener unless you opt in. Enables MeshCore on-air
                  contact telemetry polling. Companion-link reads to your own radio
                  are not transmissions and are unaffected.
                '';
              };

              txAnnounce = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = ''
                  Broadcast a one-line activity summary on the default channel, at
                  most once per 24h and never in the first 24h after start. Requires
                  txEnabled. Unsolicited automated traffic on a shared channel, so it
                  is off by default.
                '';
              };
            };
          };

          config = lib.mkIf cfg.enable {
            users.users.${cfg.user} = {
              isSystemUser = true;
              group = cfg.group;
              home = cfg.dataDir;
              createHome = true;
            };

            users.groups.${cfg.group} = {};

            systemd.services.potato-mesh-web = {
              description = "PotatoMesh Web Dashboard";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" ];

              environment = {
                RACK_ENV = "production";
                APP_ENV = "production";
                PORT = toString cfg.port;
                HOST = cfg.host;
                SITE_NAME = cfg.siteName;
                CHANNEL = cfg.channel;
                FREQUENCY = cfg.frequency;
                CONTACT_LINK = cfg.contactLink;
                MAP_CENTER = cfg.mapCenter;
                MAX_DISTANCE = toString cfg.maxDistance;
                DEBUG = if cfg.debug then "1" else "0";
                FEDERATION = if cfg.federation then "1" else "0";
                PRIVATE = if cfg.private then "1" else "0";
                XDG_DATA_HOME = cfg.dataDir;
                XDG_CONFIG_HOME = "${cfg.dataDir}/config";
                EVENTS = if cfg.events then "1" else "0";
              } // lib.optionalAttrs (cfg.announcement != null) {
                ANNOUNCEMENT = cfg.announcement;
              } // lib.optionalAttrs (cfg.ogImageUrl != null) {
                OG_IMAGE_URL = cfg.ogImageUrl;
              } // lib.optionalAttrs (cfg.pagesDir != null) {
                PAGES_DIR = cfg.pagesDir;
              } // lib.optionalAttrs (cfg.promReportIds != null) {
                PROM_REPORT_IDS = cfg.promReportIds;
              } // lib.optionalAttrs (cfg.meshtasticPreset != null) {
                MESHTASTIC_PRESET = cfg.meshtasticPreset;
              } // lib.optionalAttrs (cfg.meshtasticFreq != null) {
                MESHTASTIC_FREQ = cfg.meshtasticFreq;
              } // lib.optionalAttrs (cfg.meshcorePreset != null) {
                MESHCORE_PRESET = cfg.meshcorePreset;
              } // lib.optionalAttrs (cfg.meshcoreFreq != null) {
                MESHCORE_FREQ = cfg.meshcoreFreq;
              } // lib.optionalAttrs (cfg.instanceDomain != null) {
                INSTANCE_DOMAIN = cfg.instanceDomain;
              } // lib.optionalAttrs (cfg.mapZoom != null) {
                MAP_ZOOM = toString cfg.mapZoom;
              } // lib.optionalAttrs (cfg.allowedChannels != null) {
                ALLOWED_CHANNELS = cfg.allowedChannels;
              } // lib.optionalAttrs (cfg.hiddenChannels != null) {
                HIDDEN_CHANNELS = cfg.hiddenChannels;
              } // lib.optionalAttrs (cfg.apiToken != null) {
                API_TOKEN = cfg.apiToken;
              };

              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Group = cfg.group;
                WorkingDirectory = cfg.dataDir;
                ExecStart = "${cfg.package}/bin/potato-mesh-web";
                Restart = "always";
                RestartSec = 5;
              } // lib.optionalAttrs (cfg.apiTokenFile != null) {
                EnvironmentFile = cfg.apiTokenFile;
              };
            };

            systemd.services.potato-mesh-ingestor = lib.mkIf cfg.ingestor.enable {
              description = "PotatoMesh Python Ingestor";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" "potato-mesh-web.service" ];
              requires = [ "potato-mesh-web.service" ];

              environment = {
                INSTANCE_DOMAIN = "http://127.0.0.1:${toString cfg.port}";
                CONNECTION = cfg.ingestor.connection;
                DEBUG = if cfg.debug then "1" else "0";
                XDG_DATA_HOME = cfg.dataDir;
                TX_ENABLED = if cfg.ingestor.txEnabled then "1" else "0";
                TX_ANNOUNCE = if cfg.ingestor.txAnnounce then "1" else "0";
                PROTOCOL = cfg.ingestor.protocol;
                TRANSPORT = cfg.ingestor.transport;
                CHANNEL_INDEX = toString cfg.ingestor.channelIndex;
                ENERGY_SAVING = if cfg.ingestor.energySaving then "1" else "0";
                MESHCORE_SELF_TELEMETRY_SECONDS = toString cfg.ingestor.meshcoreSelfTelemetrySeconds;
                MESHCORE_TELEMETRY_POLL_SECONDS = toString cfg.ingestor.meshcoreTelemetryPollSeconds;
                PRIMARY_CHANNEL_ONLY = if cfg.ingestor.primaryChannelOnly then "1" else "0";
                PRIMARY_CHANNEL_KEY = cfg.ingestor.primaryChannelKey;
                MESH_UDP_GROUP = cfg.ingestor.meshUdpGroup;
                MESH_UDP_PORT = toString cfg.ingestor.meshUdpPort;
              } // lib.optionalAttrs (cfg.ingestor.primaryChannelName != null) {
                PRIMARY_CHANNEL_NAME = cfg.ingestor.primaryChannelName;
              } // lib.optionalAttrs (cfg.ingestor.nodeId != null) {
                INGESTOR_NODE_ID = cfg.ingestor.nodeId;
              } // lib.optionalAttrs (cfg.ingestor.reticulumConfigDir != null) {
                RETICULUM_CONFIG_DIR = cfg.ingestor.reticulumConfigDir;
              } // lib.optionalAttrs (cfg.ingestor.reticulumInterfaces != null) {
                RETICULUM_INTERFACES = cfg.ingestor.reticulumInterfaces;
              } // lib.optionalAttrs (cfg.allowedChannels != null) {
                ALLOWED_CHANNELS = cfg.allowedChannels;
              } // lib.optionalAttrs (cfg.hiddenChannels != null) {
                HIDDEN_CHANNELS = cfg.hiddenChannels;
              } // lib.optionalAttrs (cfg.apiToken != null) {
                API_TOKEN = cfg.apiToken;
              };

              serviceConfig = {
                Type = "simple";
                User = cfg.user;
                Group = cfg.group;
                WorkingDirectory = cfg.dataDir;
                ExecStart = "${cfg.ingestor.package}/bin/potato-mesh-ingestor";
                Restart = "always";
                RestartSec = 10;
              } // lib.optionalAttrs (cfg.apiTokenFile != null) {
                EnvironmentFile = cfg.apiTokenFile;
              };
            };
          };
        };
    };
}
