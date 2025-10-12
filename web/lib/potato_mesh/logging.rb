# frozen_string_literal: true

require "logger"
require "time"

module PotatoMesh
  # Logging utilities shared across the web application.
  module Logging
    LOGGER_NAME = "potato-mesh" # :nodoc:

    module_function

    # Build a logger configured with the potato-mesh formatter.
    #
    # @param io [#write] destination for log output.
    # @return [Logger] configured logger instance.
    def build_logger(io = $stdout)
      logger = Logger.new(io)
      logger.progname = LOGGER_NAME
      logger.formatter = method(:formatter)
      logger
    end

    # Format log entries with a consistent structure understood by the UI.
    #
    # @param severity [String] Ruby logger severity constant (e.g., "DEBUG").
    # @param time [Time] timestamp when the log entry was created.
    # @param progname [String, nil] optional application name emitting the log.
    # @param message [String] body of the log message.
    # @return [String] formatted log entry.
    def formatter(severity, time, progname, message)
      timestamp = time.utc.iso8601(3)
      body = message.is_a?(String) ? message : message.inspect
      "[#{timestamp}] [#{progname || LOGGER_NAME}] [#{severity.downcase}] #{body}\n"
    end

    # Emit a structured log entry to the provided logger instance.
    #
    # @param logger [Logger, nil] logger to emit against.
    # @param severity [Symbol] target severity (e.g., :debug, :info).
    # @param message [String] primary message text.
    # @param context [String, nil] logical component generating the entry.
    # @param metadata [Hash] supplemental structured data for the log.
    # @return [void]
    def log(logger, severity, message, context: nil, **metadata)
      return unless logger

      parts = []
      parts << "context=#{context}" if context
      metadata.each do |key, value|
        parts << format_metadata_pair(key, value)
      end
      parts << message

      logger.public_send(severity, parts.join(" "))
    end

    # Retrieve the canonical logger for the web application.
    #
    # @param target [Object, nil] object with optional +settings.logger+ accessor.
    # @return [Logger, nil] logger instance when available.
    def logger_for(target = nil)
      if target.respond_to?(:settings) && target.settings.respond_to?(:logger)
        return target.settings.logger
      end

      if defined?(PotatoMesh::Application) &&
         PotatoMesh::Application.respond_to?(:settings) &&
         PotatoMesh::Application.settings.respond_to?(:logger)
        return PotatoMesh::Application.settings.logger
      end

      nil
    end

    # Format metadata key/value pairs for structured logging output.
    #
    # @param key [Symbol, String]
    # @param value [Object]
    # @return [String]
    def format_metadata_pair(key, value)
      "#{key}=#{value.inspect}"
    end

    private_class_method :format_metadata_pair
  end
end
