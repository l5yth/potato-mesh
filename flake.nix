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
