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
require "tmpdir"
require_relative "support/suite_tmpdir"

# The suite's temporary directory (SPEC TD1, TD2): where it is made, where
# TMPDIR points, who removes it, and the check that fails a leaking run.
RSpec.describe SuiteTmpdir do
  it "points this run's TMPDIR inside SPEC_TMPDIR (TD1)" do
    expect(ENV["TMPDIR"]).to eq(File.join(SPEC_TMPDIR, "tmp"))
    expect(Dir.tmpdir).to eq(File.join(SPEC_TMPDIR, "tmp"))
    expect(File.basename(SPEC_TMPDIR)).to start_with("potato-mesh-spec-")
  end

  describe ".create!" do
    let(:env) { {} }
    let(:hooks) { [] }
    let(:exit_hook) { ->(&block) { hooks << block } }
    let(:failures) { [] }
    let(:on_failure) { ->(message) { failures << message } }

    it "makes the directory and its tmp, points TMPDIR there, and removes it at exit (TD1)" do
      root = described_class.create!(env: env, exit_hook: exit_hook, on_failure: on_failure)
      expect(File.dirname(root)).to eq(Dir.tmpdir)
      expect(File.basename(root)).to start_with("potato-mesh-spec-")
      expect(env["TMPDIR"]).to eq(File.join(root, "tmp"))
      expect(File.directory?(env["TMPDIR"])).to be(true)
      expect(hooks.size).to eq(1)

      File.write(File.join(env["TMPDIR"], "left-behind"), "")
      hooks.first.call
      expect(File.exist?(root)).to be(false)
      expect(failures).to be_empty
    end

    it "fails the run when the directory outlives its removal (TD1)" do
      root = described_class.create!(env: env, exit_hook: exit_hook, on_failure: on_failure)
      # rm_rf raises nothing when it cannot remove an entry; here it removes
      # nothing at all.
      allow(FileUtils).to receive(:rm_rf)
      hooks.first.call
      expect(failures).to eq(["SuiteTmpdir: could not remove the suite directory #{root}"])
    ensure
      FileUtils.remove_entry(root) if root
    end

    it "makes tmp owner-only, so Dir.tmpdir takes it under umask 0 (TD1)" do
      previous_umask = File.umask(0)
      root = described_class.create!(env: env, exit_hook: exit_hook)
      File.umask(previous_umask)
      expect(File.stat(env["TMPDIR"]).mode & 0o777).to eq(0o700)
      previous_tmpdir = ENV["TMPDIR"]
      begin
        ENV["TMPDIR"] = env["TMPDIR"]
        expect(Dir.tmpdir).to eq(env["TMPDIR"])
      ensure
        ENV["TMPDIR"] = previous_tmpdir
      end
    ensure
      File.umask(previous_umask) if previous_umask
      FileUtils.rm_rf(root) if root
    end

    it "leaves the directory to its owner when a forked child exits (TD1)" do
      root = described_class.create!(env: env, exit_hook: exit_hook)
      owner = Process.pid
      allow(Process).to receive(:pid).and_return(owner + 1)
      hooks.first.call
      expect(File.directory?(root)).to be(true)
    ensure
      FileUtils.rm_rf(root) if root
    end
  end

  describe ".check!" do
    it "passes an empty or missing TMPDIR (TD2)" do
      Dir.mktmpdir("suite-tmpdir-spec-") do |dir|
        expect { described_class.check!(dir) }.not_to raise_error
        expect { described_class.check!(File.join(dir, "gone")) }.not_to raise_error
      end
    end

    it "names every entry a spec left behind (TD2)" do
      Dir.mktmpdir("suite-tmpdir-spec-") do |dir|
        FileUtils.mkdir(File.join(dir, "d20261016-1-abc"))
        File.write(File.join(dir, "RackMultipart20261016-1-xyz.bin"), "")
        expect { described_class.check!(dir) }.to raise_error(
          SuiteTmpdir::LeakError,
          "specs left these in the suite TMPDIR #{dir}: RackMultipart20261016-1-xyz.bin, d20261016-1-abc",
        )
      end
    end
  end
end
