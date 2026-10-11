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
require "fileutils"
require "tmpdir"
require_relative "support/stub_interpreter"

RSpec.describe PotatoMesh::App::Meshtastic::PayloadDecoder do
  def with_env(key, value)
    previous = ENV[key]
    ENV[key] = value
    yield
  ensure
    ENV[key] = previous
  end

  def with_repo_root(path)
    allow(PotatoMesh::Config).to receive(:repo_root).and_return(path)
    yield
  end

  it "prefers a configured python path" do
    Dir.mktmpdir do |dir|
      with_env("MESHTASTIC_PYTHON", "/custom/python") do
        with_repo_root(dir) do
          expect(described_class.python_executable_path).to eq("/custom/python")
        end
      end
    end
  end

  it "uses the project venv when present" do
    Dir.mktmpdir do |dir|
      python_path = File.join(dir, "data", ".venv", "bin", "python")
      FileUtils.mkdir_p(File.dirname(python_path))
      File.write(python_path, "")
      FileUtils.chmod(0o755, python_path)

      with_env("MESHTASTIC_PYTHON", nil) do
        with_repo_root(dir) do
          expect(described_class.python_executable_path).to eq(python_path)
        end
      end
    end
  end

  it "falls back to python on PATH when no venv is available" do
    Dir.mktmpdir do |dir|
      fake_bin = File.join(dir, "bin")
      FileUtils.mkdir_p(fake_bin)
      python_path = File.join(fake_bin, "python3")
      File.write(python_path, "#!/bin/sh\n")
      FileUtils.chmod(0o755, python_path)

      with_env("MESHTASTIC_PYTHON", nil) do
        with_env("PATH", fake_bin) do
          with_repo_root(dir) do
            expect(described_class.python_executable_path).to eq(python_path)
          end
        end
      end
    end
  end

  it "resolves the decoder script path from the repo root" do
    Dir.mktmpdir do |dir|
      script_path = File.join(dir, "data", "mesh_ingestor", "decode_payload.py")
      FileUtils.mkdir_p(File.dirname(script_path))
      File.write(script_path, "")

      with_repo_root(dir) do
        expect(described_class.decoder_script_path).to eq(script_path)
      end
    end
  end

  it "falls back to the web root when the repo root is unavailable" do
    Dir.mktmpdir do |dir|
      script_path = File.join(dir, "data", "mesh_ingestor", "decode_payload.py")
      FileUtils.mkdir_p(File.dirname(script_path))
      File.write(script_path, "")

      with_repo_root(Dir.mktmpdir) do
        allow(PotatoMesh::Config).to receive(:web_root).and_return(dir)
        expect(described_class.decoder_script_path).to eq(script_path)
      end
    end
  end

  it "returns nil when the decoder script is missing" do
    Dir.mktmpdir do |dir|
      with_repo_root(dir) do
        expect(described_class.decoder_script_path).to be_nil
      end
    end
  end

  # Point the decoder at a stub interpreter that replies +reply+ and exits
  # with +status+ (+support/stub_interpreter.rb+).
  #
  # @param dir [String] directory that receives the stub.
  # @param reply [String] stdout of the stub.
  # @param status [Integer] exit status of the stub.
  # @return [void]
  def use_replying_interpreter(dir, reply, status: 0)
    allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
    allow(described_class).to receive(:python_executable_path).and_return(
      StubInterpreter.replying(dir, reply, status: status),
    )
  end

  it "returns the decoder's reply as a hash" do
    Dir.mktmpdir do |dir|
      use_replying_interpreter(dir, StubInterpreter::POSITION_REPLY)

      expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to eq(JSON.parse(StubInterpreter::POSITION_REPLY))
    end
  end

  it "runs the decoder script with the request as JSON on stdin" do
    Dir.mktmpdir do |dir|
      allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
      allow(described_class).to receive(:python_executable_path).and_return(
        StubInterpreter.write(dir, %(echo "$@" > "#{dir}/argv"\ncat > "#{dir}/request.json"\nprintf '%s' '{}')),
      )

      expect(described_class.decode(portnum: 67, payload_b64: "AQI=")).to eq({})
      expect(File.read(File.join(dir, "argv"))).to eq("/tmp/decoder.py\n")
      expect(JSON.parse(File.read(File.join(dir, "request.json")))).to eq("portnum" => 67, "payload_b64" => "AQI=")
    end
  end

  it "returns nil when the decoder process fails" do
    Dir.mktmpdir do |dir|
      use_replying_interpreter(dir, "{}", status: 1)

      expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
    end
  end

  it "returns nil when decoder output is invalid JSON" do
    Dir.mktmpdir do |dir|
      use_replying_interpreter(dir, "not-json")

      expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
    end
  end

  it "returns nil when decoder output includes an error" do
    Dir.mktmpdir do |dir|
      use_replying_interpreter(dir, JSON.generate("error" => "boom"))

      expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
    end
  end

  it "returns nil when decoder output is not a hash" do
    Dir.mktmpdir do |dir|
      use_replying_interpreter(dir, JSON.generate([1, 2, 3]))

      expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
    end
  end

  it "returns nil when the decoder executable is missing" do
    allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
    allow(described_class).to receive(:python_executable_path).and_return("/missing/python")

    expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
  end

  it "returns nil when the interpreter path cannot be passed to the system" do
    allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
    allow(described_class).to receive(:python_executable_path).and_return("/usr/bin/python3\0")

    expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
  end

  it "returns nil when decoder paths are unavailable" do
    allow(described_class).to receive(:decoder_script_path).and_return(nil)
    allow(described_class).to receive(:python_executable_path).and_return(nil)

    expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
  end

  it "returns nil when no python executable can be found" do
    with_env("MESHTASTIC_PYTHON", nil) do
      with_env("PATH", "") do
        with_repo_root(Dir.mktmpdir) do
          expect(described_class.python_executable_path).to be_nil
        end
      end
    end
  end

  it "returns nil when inputs are missing" do
    expect(described_class.decode(portnum: nil, payload_b64: "AA==")).to be_nil
    expect(described_class.decode(portnum: 3, payload_b64: nil)).to be_nil
  end

  it "falls back to PATH when configured python is blank" do
    Dir.mktmpdir do |dir|
      fake_bin = File.join(dir, "bin")
      FileUtils.mkdir_p(fake_bin)
      python_path = File.join(fake_bin, "python")
      File.write(python_path, "#!/bin/sh\n")
      FileUtils.chmod(0o755, python_path)

      with_env("MESHTASTIC_PYTHON", " ") do
        with_env("PATH", fake_bin) do
          with_repo_root(dir) do
            expect(described_class.python_executable_path).to eq(python_path)
          end
        end
      end
    end
  end
end
