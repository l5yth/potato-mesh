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

require "spec_helper"

# Unit tests for the runtime Open Graph image module. The capture strategy
# is replaced with deterministic stubs so the full cache/fallback matrix
# can be exercised without spawning Chromium.
RSpec.describe PotatoMesh::OgImage do
  let(:cache_path) { File.join(SPEC_TMPDIR, "og-cache-#{SecureRandom.hex(4)}.png") }
  let(:default_path) { File.join(SPEC_TMPDIR, "og-default-#{SecureRandom.hex(4)}.png") }

  before do
    File.binwrite(default_path, "DEFAULT_BYTES")
    allow(PotatoMesh::Config).to receive(:og_image_cache_path).and_return(cache_path)
    allow(PotatoMesh::Config).to receive(:og_image_default_path).and_return(default_path)
    described_class.reset_for_tests!
  end

  after do
    described_class.reset_for_tests!
  rescue StandardError
    # Cleanup is best effort; some specs intentionally stub File ops.
  ensure
    begin
      File.unlink(default_path) if File.exist?(default_path)
    rescue StandardError
      nil
    end
    begin
      File.unlink(cache_path) if File.exist?(cache_path)
    rescue StandardError
      nil
    end
  end

  describe ".serve" do
    it "captures and caches a fresh image on first request" do
      described_class.capture_strategy = ->(_) { "FRESH_BYTES" }

      payload = described_class.serve(base_url: "http://localhost:41447")

      expect(payload[:bytes]).to eq("FRESH_BYTES")
      expect(payload[:max_age]).to eq(PotatoMesh::Config.og_image_ttl_seconds)
      expect(File.binread(cache_path)).to eq("FRESH_BYTES")
    end

    it "passes the supplied base_url to the capture strategy" do
      received = nil
      described_class.capture_strategy = ->(url) { received = url; "BYTES" }

      described_class.serve(base_url: "http://example.test")

      expect(received).to eq("http://example.test")
    end

    it "returns the cached image while it remains fresh" do
      File.binwrite(cache_path, "CACHED_BYTES")
      described_class.capture_strategy = ->(_) { raise "should not be called" }

      payload = described_class.serve(base_url: "http://localhost")

      expect(payload[:bytes]).to eq("CACHED_BYTES")
    end

    it "refreshes when the cache is older than the TTL" do
      File.binwrite(cache_path, "STALE_BYTES")
      stale_time = Time.now - PotatoMesh::Config.og_image_ttl_seconds - 60
      File.utime(stale_time, stale_time, cache_path)
      described_class.capture_strategy = ->(_) { "REFRESHED_BYTES" }

      payload = described_class.serve(base_url: "http://localhost")

      expect(payload[:bytes]).to eq("REFRESHED_BYTES")
      expect(File.binread(cache_path)).to eq("REFRESHED_BYTES")
    end

    it "falls back to the cached image when capture raises" do
      File.binwrite(cache_path, "STALE_BYTES")
      stale_time = Time.now - PotatoMesh::Config.og_image_ttl_seconds - 60
      File.utime(stale_time, stale_time, cache_path)
      described_class.capture_strategy = ->(_) { raise PotatoMesh::OgImage::CaptureError, "browser exploded" }

      payload = described_class.serve(base_url: "http://localhost")

      expect(payload[:bytes]).to eq("STALE_BYTES")
    end

    it "falls back to the default image when capture fails and no cache exists" do
      described_class.capture_strategy = ->(_) { raise PotatoMesh::OgImage::CaptureError, "no chromium" }

      payload = described_class.serve(base_url: "http://localhost")

      expect(payload[:bytes]).to eq("DEFAULT_BYTES")
    end

    it "raises CaptureError when neither capture nor default are available" do
      described_class.capture_strategy = ->(_) { raise PotatoMesh::OgImage::CaptureError, "no chromium" }
      File.unlink(default_path)

      expect { described_class.serve(base_url: "http://localhost") }.to raise_error(PotatoMesh::OgImage::CaptureError)
    end
  end

  describe ".attempt_refresh" do
    it "returns nil when the capture mutex is already held" do
      held = Mutex.new
      original = described_class.instance_variable_get(:@capture_mutex)
      described_class.instance_variable_set(:@capture_mutex, held)
      held.lock

      begin
        result = described_class.attempt_refresh("http://localhost")
        expect(result).to be_nil
      ensure
        held.unlock
        described_class.instance_variable_set(:@capture_mutex, original)
      end
    end

    it "logs and returns nil when capture raises" do
      logger = instance_double(Logger, warn: nil)
      allow(PotatoMesh::Logging).to receive(:logger_for).and_return(logger)
      described_class.capture_strategy = ->(_) { raise PotatoMesh::OgImage::CaptureError, "oops" }

      result = described_class.attempt_refresh("http://localhost")

      expect(result).to be_nil
      expect(PotatoMesh::Logging).to have_received(:logger_for).at_least(:once)
    end

    it "skips capture while the failure backoff window is active" do
      described_class.instance_variable_set(:@last_failure_at, Time.now)
      sentinel = ->(_) { raise "capture should not run during backoff" }
      described_class.capture_strategy = sentinel

      expect(described_class.attempt_refresh("http://localhost")).to be_nil
    end

    it "retries capture once the failure backoff window has elapsed" do
      backoff = PotatoMesh::OgImage::CAPTURE_FAILURE_BACKOFF_SECONDS + 1
      described_class.instance_variable_set(:@last_failure_at, Time.now - backoff)
      described_class.capture_strategy = ->(_) { "RECOVERED" }

      result = described_class.attempt_refresh("http://localhost")

      expect(result).not_to be_nil
      expect(result.first).to eq("RECOVERED")
      expect(described_class.instance_variable_get(:@last_failure_at)).to be_nil
    end

    it "records a failure timestamp when the disk write fails" do
      described_class.capture_strategy = ->(_) { "BYTES" }
      allow(File).to receive(:binwrite).and_raise(Errno::ENOSPC)

      result = described_class.attempt_refresh("http://localhost")

      expect(result).not_to be_nil
      expect(described_class.instance_variable_get(:@last_failure_at)).to be_a(Time)
    end
  end

  describe ".in_failure_backoff?" do
    it "is false when no failure has been recorded" do
      described_class.instance_variable_set(:@last_failure_at, nil)
      expect(described_class.in_failure_backoff?).to be(false)
    end

    it "is true while inside the backoff window" do
      described_class.instance_variable_set(:@last_failure_at, Time.now)
      expect(described_class.in_failure_backoff?).to be(true)
    end

    it "is false once the backoff window has elapsed" do
      backoff = PotatoMesh::OgImage::CAPTURE_FAILURE_BACKOFF_SECONDS + 1
      described_class.instance_variable_set(:@last_failure_at, Time.now - backoff)
      expect(described_class.in_failure_backoff?).to be(false)
    end
  end

  describe ".invoke_capture" do
    it "delegates to the configured strategy" do
      described_class.capture_strategy = ->(url) { "BYTES_FOR_#{url}" }

      expect(described_class.invoke_capture("alpha")).to eq("BYTES_FOR_alpha")
    end

    it "falls back to default_capture when no strategy is configured" do
      described_class.capture_strategy = nil
      expect(described_class).to receive(:default_capture).with("alpha").and_return("DEF")

      expect(described_class.invoke_capture("alpha")).to eq("DEF")
    end
  end

  describe ".browser_options" do
    it "honors the configured viewport dimensions" do
      options = described_class.browser_options

      expect(options[:window_size]).to eq([
        PotatoMesh::Config.og_image_viewport_width,
        PotatoMesh::Config.og_image_viewport_height,
      ])
      expect(options[:headless]).to be true
    end

    # `--no-sandbox` is required for non-root Alpine containers; removing
    # it would silently break Chromium launches in production. The
    # corresponding assertion lives in security review (see comment in
    # OgImage.browser_options).
    it "passes the --no-sandbox flag" do
      options = described_class.browser_options

      expect(options[:browser_options]).to have_key(:"no-sandbox")
    end

    it "passes the --disable-dev-shm-usage flag" do
      options = described_class.browser_options

      expect(options[:browser_options]).to have_key(:"disable-dev-shm-usage")
    end

    it "passes the FERRUM_BROWSER_PATH env when present" do
      original = ENV["FERRUM_BROWSER_PATH"]
      ENV["FERRUM_BROWSER_PATH"] = "/custom/chromium"
      begin
        options = described_class.browser_options
        expect(options[:browser_path]).to eq("/custom/chromium")
      ensure
        if original
          ENV["FERRUM_BROWSER_PATH"] = original
        else
          ENV.delete("FERRUM_BROWSER_PATH")
        end
      end
    end

    it "omits browser_path when the env var is unset" do
      original = ENV["FERRUM_BROWSER_PATH"]
      ENV.delete("FERRUM_BROWSER_PATH")
      begin
        options = described_class.browser_options
        expect(options).not_to have_key(:browser_path)
      ensure
        ENV["FERRUM_BROWSER_PATH"] = original if original
      end
    end
  end

  describe ".default_capture" do
    it "wraps Ferrum errors in CaptureError" do
      browser_double = double("browser")
      allow(browser_double).to receive(:goto).and_raise(StandardError, "boom")
      allow(browser_double).to receive(:quit)
      allow(described_class).to receive(:build_browser).and_return(browser_double)
      allow(described_class).to receive(:wait_for_settled)

      expect { described_class.default_capture("http://localhost") }.to raise_error(PotatoMesh::OgImage::CaptureError, /capture failed/)
    end

    it "returns the screenshot bytes from the browser" do
      browser_double = double("browser")
      allow(browser_double).to receive(:goto)
      allow(browser_double).to receive(:quit)
      allow(browser_double).to receive(:screenshot).and_return("PNG")
      allow(described_class).to receive(:build_browser).and_return(browser_double)
      allow(described_class).to receive(:wait_for_settled)

      expect(described_class.default_capture("http://localhost")).to eq("PNG")
    end

    it "wraps a missing ferrum gem in CaptureError" do
      allow(described_class).to receive(:build_browser).and_raise(LoadError, "cannot load such file -- ferrum")

      expect { described_class.default_capture("http://localhost") }.to raise_error(PotatoMesh::OgImage::CaptureError, /ferrum not installed/)
    end
  end

  describe ".wait_for_settled" do
    it "returns silently when the browser does not expose network" do
      stub = double("browser")
      allow(stub).to receive(:respond_to?).with(:network).and_return(false)

      expect { described_class.wait_for_settled(stub) }.not_to raise_error
    end

    it "swallows idle timeouts" do
      network = double("network")
      allow(network).to receive(:wait_for_idle).and_raise(StandardError, "idle timeout")
      stub = double("browser", network: network)
      allow(stub).to receive(:respond_to?).with(:network).and_return(true)

      expect { described_class.wait_for_settled(stub) }.not_to raise_error
    end
  end

  describe ".safely_quit_browser" do
    it "is a no-op when the browser is nil" do
      expect { described_class.safely_quit_browser(nil) }.not_to raise_error
    end

    it "ignores errors raised during quit" do
      stub = double("browser")
      allow(stub).to receive(:quit).and_raise(StandardError, "already dead")

      expect { described_class.safely_quit_browser(stub) }.not_to raise_error
    end
  end

  describe ".cache_fresh?" do
    it "returns false when the mtime is not a Time" do
      expect(described_class.cache_fresh?(nil)).to be(false)
    end

    it "returns true for a recent mtime" do
      expect(described_class.cache_fresh?(Time.now - 1)).to be(true)
    end

    it "returns false for an mtime older than the TTL" do
      old = Time.now - PotatoMesh::Config.og_image_ttl_seconds - 1
      expect(described_class.cache_fresh?(old)).to be(false)
    end
  end

  describe ".read_cache" do
    it "returns nil when the cache file does not exist" do
      expect(described_class.read_cache).to be_nil
    end

    it "returns nil when the cache file is empty" do
      File.binwrite(cache_path, "")
      expect(described_class.read_cache).to be_nil
    end

    it "returns the bytes and mtime when the file exists" do
      File.binwrite(cache_path, "BYTES")
      result = described_class.read_cache
      expect(result[:bytes]).to eq("BYTES")
      expect(result[:mtime]).to be_a(Time)
    end

    it "returns nil on filesystem errors" do
      File.binwrite(cache_path, "BYTES")
      allow(File).to receive(:binread).with(cache_path).and_raise(Errno::EIO)

      expect(described_class.read_cache).to be_nil
    end
  end

  describe ".write_cache" do
    it "returns false for empty input" do
      expect(described_class.write_cache("")).to be(false)
      expect(File.exist?(cache_path)).to be(false)
    end

    it "returns false for non-string input" do
      expect(described_class.write_cache(nil)).to be(false)
      expect(File.exist?(cache_path)).to be(false)
    end

    it "creates the cache directory when missing and returns true" do
      nested_path = File.join(SPEC_TMPDIR, "og-nested-#{SecureRandom.hex(4)}", "img.png")
      allow(PotatoMesh::Config).to receive(:og_image_cache_path).and_return(nested_path)

      expect(described_class.write_cache("PAYLOAD")).to be(true)
      expect(File.binread(nested_path)).to eq("PAYLOAD")
    ensure
      FileUtils.rm_rf(File.dirname(nested_path)) if nested_path
    end

    it "returns false and logs when the disk write fails" do
      logger = instance_double(Logger, warn: nil)
      allow(PotatoMesh::Logging).to receive(:logger_for).and_return(logger)
      allow(File).to receive(:binwrite).and_raise(Errno::EIO)

      expect(described_class.write_cache("DATA")).to be(false)
    end
  end

  describe ".read_default" do
    it "returns nil when the default file is missing" do
      File.unlink(default_path)
      expect(described_class.read_default).to be_nil
    end

    it "returns nil on filesystem errors" do
      allow(File).to receive(:binread).with(default_path).and_raise(Errno::EIO)
      expect(described_class.read_default).to be_nil
    end

    it "returns the bytes and mtime when present" do
      bytes, mtime = described_class.read_default
      expect(bytes).to eq("DEFAULT_BYTES")
      expect(mtime).to be_a(Time)
    end
  end

  describe ".log_capture_error" do
    it "is a no-op when no logger is available" do
      allow(PotatoMesh::Logging).to receive(:logger_for).and_return(nil)

      expect { described_class.log_capture_error(StandardError.new("x")) }.not_to raise_error
    end

    it "delegates to the logging helper when a logger is configured" do
      logger = instance_double(Logger, warn: nil)
      allow(PotatoMesh::Logging).to receive(:logger_for).and_return(logger)

      described_class.log_capture_error(StandardError.new("test"))

      expect(logger).to have_received(:warn).at_least(:once)
    end
  end

  describe ".reset_for_tests!" do
    it "clears the cache file" do
      File.binwrite(cache_path, "STALE")
      described_class.reset_for_tests!
      expect(File.exist?(cache_path)).to be(false)
    end

    it "ignores filesystem errors" do
      File.binwrite(cache_path, "STALE")
      allow(File).to receive(:unlink).and_call_original
      allow(File).to receive(:unlink).with(cache_path).and_raise(Errno::EIO)

      expect { described_class.reset_for_tests! }.not_to raise_error
    end
  end
end
