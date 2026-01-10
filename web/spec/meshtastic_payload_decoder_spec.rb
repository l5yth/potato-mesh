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

  it "returns nil when the decoder process fails" do
    allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
    allow(described_class).to receive(:python_executable_path).and_return("/usr/bin/python3")
    allow(Open3).to receive(:capture3).and_return(["{}", "boom", instance_double(Process::Status, success?: false)])

    expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
  end

  it "returns nil when decoder output is invalid JSON" do
    allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
    allow(described_class).to receive(:python_executable_path).and_return("/usr/bin/python3")
    allow(Open3).to receive(:capture3).and_return(["not-json", "", instance_double(Process::Status, success?: true)])

    expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
  end

  it "returns nil when decoder output includes an error" do
    allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
    allow(described_class).to receive(:python_executable_path).and_return("/usr/bin/python3")
    allow(Open3).to receive(:capture3).and_return([JSON.generate("error" => "boom"), "", instance_double(Process::Status, success?: true)])

    expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
  end

  it "returns nil when decoder output is not a hash" do
    allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
    allow(described_class).to receive(:python_executable_path).and_return("/usr/bin/python3")
    allow(Open3).to receive(:capture3).and_return([JSON.generate([1, 2, 3]), "", instance_double(Process::Status, success?: true)])

    expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
  end

  it "returns nil when the decoder executable is missing" do
    allow(described_class).to receive(:decoder_script_path).and_return("/tmp/decoder.py")
    allow(described_class).to receive(:python_executable_path).and_return("/missing/python")
    allow(Open3).to receive(:capture3).and_raise(Errno::ENOENT)

    expect(described_class.decode(portnum: 3, payload_b64: "AA==")).to be_nil
  end
end
