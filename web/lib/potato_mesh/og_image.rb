# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# frozen_string_literal: true

require "fileutils"

require_relative "config"
require_relative "logging"

module PotatoMesh
  # Runtime generator and cache layer for the Open Graph / Twitter Card
  # preview image served at +/og-image.png+.
  #
  # The module is responsible for:
  #
  # * Producing a 1200×630 PNG screenshot of the dashboard via
  #   {Ferrum} (Chrome DevTools Protocol).
  # * Caching successful captures on disk so that subsequent crawler hits
  #   are cheap.
  # * Falling back to the previous cache (or the bundled default PNG) when
  #   a capture cannot be performed — for example, because Chromium is
  #   unavailable in the runtime image.
  #
  # The capture step is encapsulated in {.invoke_capture} so test suites
  # can substitute it with {.capture_strategy=} and exercise the cache and
  # response paths without launching a real browser.
  module OgImage
    module_function

    # Raised when the capture pipeline could not produce a screenshot for
    # any reason (Chromium missing, navigation timeout, transient network
    # failure, etc.). Callers translate it into a fallback response.
    class CaptureError < StandardError; end

    # Lazily-initialised mutex guarding capture invocations to prevent a
    # thundering-herd of concurrent crawler requests from spawning multiple
    # browsers.
    @capture_mutex = Mutex.new

    # Optional override for the capture function. When set, {.invoke_capture}
    # delegates to this callable instead of {.default_capture}; tests use
    # this hook to inject deterministic byte payloads.
    @capture_strategy = nil

    # Produce a response payload for the +/og-image.png+ route.
    #
    # @param base_url [String] absolute URL of the running application, used
    #   as the navigation target for the headless browser.
    # @return [Hash] hash with +:bytes+ (binary PNG payload),
    #   +:last_modified+ ({Time}), and +:max_age+ (Integer seconds for the
    #   Cache-Control header).
    def serve(base_url:)
      bytes, last_modified = resolve_image_bytes(base_url: base_url)
      {
        bytes: bytes,
        last_modified: last_modified,
        max_age: PotatoMesh::Config.og_image_ttl_seconds,
      }
    end

    # Resolve the freshest image bytes available, capturing a new
    # screenshot when the cache is empty or stale.
    #
    # @param base_url [String] dashboard URL captured by Ferrum.
    # @return [Array(String, Time)] PNG payload and its last-modified
    #   timestamp.
    def resolve_image_bytes(base_url:)
      cache = read_cache
      return [cache[:bytes], cache[:mtime]] if cache && cache_fresh?(cache[:mtime])

      refreshed = attempt_refresh(base_url)
      return refreshed if refreshed

      return [cache[:bytes], cache[:mtime]] if cache

      default = read_default
      return default if default

      raise CaptureError, "no preview image available"
    end

    # Try to capture a fresh screenshot, returning the new payload on
    # success and +nil+ when the capture failed or another thread is
    # already running one.
    #
    # @param base_url [String] dashboard URL captured by Ferrum.
    # @return [Array(String, Time), nil] new bytes and timestamp, or +nil+.
    def attempt_refresh(base_url)
      acquired = @capture_mutex.try_lock
      return nil unless acquired

      begin
        bytes = invoke_capture(base_url)
        write_cache(bytes)
        [bytes, Time.now]
      rescue StandardError => e
        log_capture_error(e)
        nil
      ensure
        @capture_mutex.unlock if @capture_mutex.owned?
      end
    end

    # Invoke either the configured {.capture_strategy} or
    # {.default_capture} to produce PNG bytes.
    #
    # @param base_url [String] navigation target.
    # @return [String] binary PNG payload.
    def invoke_capture(base_url)
      strategy = @capture_strategy || method(:default_capture)
      strategy.call(base_url)
    end

    # Default capture implementation backed by the +ferrum+ gem.
    #
    # The browser is launched with the configured viewport, navigated to
    # +base_url+, and given a brief idle window before the screenshot is
    # taken. Errors raised by Ferrum are wrapped in {CaptureError} so the
    # serve path can fall back gracefully.
    #
    # @param base_url [String] navigation target.
    # @return [String] binary PNG payload.
    # @raise [CaptureError] when the capture cannot be performed.
    def default_capture(base_url)
      browser = build_browser
      begin
        browser.goto(base_url.to_s)
        wait_for_settled(browser)
        bytes = browser.screenshot(format: "png", encoding: :binary, full: false)
        bytes.is_a?(String) ? bytes : bytes.to_s
      ensure
        safely_quit_browser(browser)
      end
    rescue LoadError => e
      raise CaptureError, "ferrum not installed: #{e.message}"
    rescue StandardError => e
      raise CaptureError, "capture failed: #{e.message}"
    end

    # Construct a fresh Ferrum browser instance using configuration values.
    # Loads the gem lazily so importing this module does not pull Chromium
    # into environments that never need it.
    #
    # @return [Object] Ferrum::Browser instance.
    def build_browser
      require "ferrum"
      Ferrum::Browser.new(browser_options)
    end

    # Build the option hash passed to +Ferrum::Browser.new+. Extracted as
    # a separate method so tests can verify the dimensions without
    # launching the browser.
    #
    # @return [Hash] keyword options for Ferrum::Browser.
    def browser_options
      options = {
        headless: true,
        window_size: [
          PotatoMesh::Config.og_image_viewport_width,
          PotatoMesh::Config.og_image_viewport_height,
        ],
        timeout: PotatoMesh::Config.og_image_navigation_timeout,
        process_timeout: PotatoMesh::Config.og_image_navigation_timeout,
        browser_options: {
          "no-sandbox": nil,
          "disable-dev-shm-usage": nil,
          "disable-gpu": nil,
        },
      }
      browser_path = ENV["FERRUM_BROWSER_PATH"]
      options[:browser_path] = browser_path if browser_path && !browser_path.empty?
      options
    end

    # Wait for the dashboard to reach a stable state before capturing.
    # Network-idle timeouts are tolerated because some dashboard widgets
    # may continue polling indefinitely.
    #
    # @param browser [Object] Ferrum::Browser instance.
    # @return [void]
    def wait_for_settled(browser)
      return unless browser.respond_to?(:network)

      browser.network.wait_for_idle(
        duration: PotatoMesh::Config.og_image_network_idle_duration,
        timeout: PotatoMesh::Config.og_image_network_idle_timeout,
      )
    rescue StandardError
      # Idle timeout — proceed with a best-effort capture.
    end

    # Quit the browser, ignoring shutdown errors so a slow or already-dead
    # browser does not mask the original exception.
    #
    # @param browser [Object, nil] Ferrum::Browser instance.
    # @return [void]
    def safely_quit_browser(browser)
      return if browser.nil?

      browser.quit
    rescue StandardError
      # Best-effort cleanup — never let teardown raise.
    end

    # Read the cached preview from disk when present and readable.
    #
    # @return [Hash{Symbol=>Object}, nil] hash with +:bytes+ and +:mtime+
    #   keys, or +nil+ when no cache file exists.
    def read_cache
      path = PotatoMesh::Config.og_image_cache_path
      return nil unless File.file?(path) && File.readable?(path)

      bytes = File.binread(path)
      return nil if bytes.empty?

      { bytes: bytes, mtime: File.mtime(path) }
    rescue SystemCallError
      nil
    end

    # Persist the freshly-captured PNG payload to the cache location.
    #
    # @param bytes [String] binary PNG payload.
    # @return [void]
    def write_cache(bytes)
      return unless bytes.is_a?(String) && !bytes.empty?

      path = PotatoMesh::Config.og_image_cache_path
      FileUtils.mkdir_p(File.dirname(path))
      File.binwrite(path, bytes)
    rescue SystemCallError => e
      log_capture_error(e)
    end

    # Determine whether the cache mtime falls inside the configured TTL.
    #
    # @param mtime [Time] cache file modification time.
    # @return [Boolean] +true+ when the cache is still fresh.
    def cache_fresh?(mtime)
      return false unless mtime.is_a?(Time)

      (Time.now - mtime) < PotatoMesh::Config.og_image_ttl_seconds
    end

    # Read the bundled default PNG as a last-resort fallback.
    #
    # @return [Array(String, Time), nil] payload and modification time, or
    #   +nil+ when the default file is missing.
    def read_default
      path = PotatoMesh::Config.og_image_default_path
      return nil unless File.file?(path) && File.readable?(path)

      [File.binread(path), File.mtime(path)]
    rescue SystemCallError
      nil
    end

    # Override the capture strategy. Intended for test suites that need to
    # exercise the serve/cache logic without spawning Chromium.
    #
    # @param callable [#call, nil] callable that accepts +base_url+ and
    #   returns PNG bytes, or +nil+ to restore {.default_capture}.
    # @return [void]
    def capture_strategy=(callable)
      @capture_strategy = callable
    end

    # Reset module state for use in tests. Releases the capture mutex if it
    # is held, clears the configured strategy, and removes the cache file.
    #
    # @return [void]
    def reset_for_tests!
      @capture_strategy = nil
      @capture_mutex.unlock if @capture_mutex.owned?
      path = PotatoMesh::Config.og_image_cache_path
      File.unlink(path) if File.exist?(path)
    rescue SystemCallError
      # Cache cleanup is best-effort; ignore filesystem errors.
    end

    # Emit a structured warning when capture or cache I/O fails. Logging is
    # best-effort: errors are swallowed when no logger is available so the
    # serve path can continue to fall back without raising.
    #
    # @param error [Exception] caught error instance.
    # @return [void]
    def log_capture_error(error)
      logger = PotatoMesh::Logging.logger_for
      return unless logger

      PotatoMesh::Logging.log(
        logger,
        :warn,
        "preview capture fell back to cache/default",
        context: "og_image",
        error: error.class.name,
        message: error.message,
      )
    end
  end
end
