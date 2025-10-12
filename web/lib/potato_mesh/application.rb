# frozen_string_literal: true

require "sinatra/base"
require "json"
require "sqlite3"
require "fileutils"
require "logger"
require "rack/utils"
require "open3"
require "resolv"
require "socket"
require "time"
require "openssl"
require "base64"
require "prometheus/client"
require "prometheus/client/formats/text"
require "prometheus/middleware/collector"
require "prometheus/middleware/exporter"
require "net/http"
require "uri"
require "ipaddr"
require "set"
require "digest"

require_relative "config"
require_relative "sanitizer"
require_relative "meta"
require_relative "logging"
require_relative "application/helpers"
require_relative "application/errors"
require_relative "application/database"
require_relative "application/networking"
require_relative "application/identity"
require_relative "application/federation"
require_relative "application/prometheus"
require_relative "application/queries"
require_relative "application/data_processing"
require_relative "application/routes/api"
require_relative "application/routes/ingest"
require_relative "application/routes/root"

module PotatoMesh
  class Application < Sinatra::Base
    extend App::Helpers
    extend App::Database
    extend App::Networking
    extend App::Identity
    extend App::Federation
    extend App::Prometheus
    extend App::Queries
    extend App::DataProcessing

    helpers App::Helpers
    include App::Database
    include App::Networking
    include App::Identity
    include App::Federation
    include App::Prometheus
    include App::Queries
    include App::DataProcessing

    register App::Routes::Api
    register App::Routes::Ingest
    register App::Routes::Root

    APP_VERSION = determine_app_version
    INSTANCE_PRIVATE_KEY, INSTANCE_KEY_GENERATED = load_or_generate_instance_private_key
    INSTANCE_PUBLIC_KEY_PEM = INSTANCE_PRIVATE_KEY.public_key.export
    SELF_INSTANCE_ID = Digest::SHA256.hexdigest(INSTANCE_PUBLIC_KEY_PEM)
    INSTANCE_DOMAIN, INSTANCE_DOMAIN_SOURCE = determine_instance_domain

    def self.apply_logger_level!
      logger = settings.logger
      return unless logger

      logger.level = PotatoMesh::Config.debug? ? Logger::DEBUG : Logger::WARN
    end

    # Determine the port the application should listen on.
    #
    # @param default_port [Integer] fallback port when ENV['PORT'] is absent or invalid.
    # @return [Integer] port number for the HTTP server.
    def self.resolve_port(default_port: 41_447)
      raw = ENV["PORT"]
      return default_port if raw.nil?

      Integer(raw, 10)
    rescue ArgumentError
      default_port
    end

    configure do
      set :public_folder, File.expand_path("../../public", __dir__)
      set :views, File.expand_path("../../views", __dir__)
      set :federation_thread, nil
      set :port, resolve_port

      app_logger = PotatoMesh::Logging.build_logger($stdout)
      set :logger, app_logger
      use Rack::CommonLogger, app_logger
      use Rack::Deflater
      use ::Prometheus::Middleware::Collector
      use ::Prometheus::Middleware::Exporter

      apply_logger_level!

      cleanup_legacy_well_known_artifacts
      init_db unless db_schema_present?
      ensure_schema_upgrades

      log_instance_domain_resolution
      log_instance_public_key
      refresh_well_known_document_if_stale
      ensure_self_instance_record!
      update_all_prometheus_metrics_from_nodes

      if federation_announcements_active?
        start_initial_federation_announcement!
        start_federation_announcer!
      elsif federation_enabled?
        debug_log(
          "Federation announcements disabled",
          context: "federation",
          reason: "test environment",
        )
      else
        debug_log(
          "Federation announcements disabled",
          context: "federation",
          reason: "configuration",
        )
      end
    end
  end
end

if defined?(Sinatra::Application) && Sinatra::Application != PotatoMesh::Application
  Sinatra.send(:remove_const, :Application)
end
Sinatra::Application = PotatoMesh::Application unless defined?(Sinatra::Application)

APP_VERSION = PotatoMesh::Application::APP_VERSION unless defined?(APP_VERSION)
SELF_INSTANCE_ID = PotatoMesh::Application::SELF_INSTANCE_ID unless defined?(SELF_INSTANCE_ID)

[
  PotatoMesh::App::Helpers,
  PotatoMesh::App::Database,
  PotatoMesh::App::Networking,
  PotatoMesh::App::Identity,
  PotatoMesh::App::Federation,
  PotatoMesh::App::Prometheus,
  PotatoMesh::App::Queries,
  PotatoMesh::App::DataProcessing,
].each do |mod|
  Object.include(mod) unless Object < mod
end
