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

# SPEC CV2: the LCOV report Codecov reads and the full-suite coverage floor.
RSpec.describe CoverageGate do
  let(:source_file) { Struct.new(:filename, :lines, :branches) }

  # A SimpleCov line with +coverage+ hits (+nil+ for a line that never counts).
  def line(number, coverage)
    SimpleCov::SourceFile::Line.new("value = #{number}", number, coverage)
  end

  # A SimpleCov branch arm starting on +start_line+.
  def branch(start_line, coverage, inline: false, type: :then)
    SimpleCov::SourceFile::Branch.new(
      start_line: start_line,
      end_line: start_line,
      coverage: coverage,
      inline: inline,
      type: type,
    )
  end

  # An RSpec configuration stand-in running +files+, with or without an
  # inclusion filter (a line number, -e or --tag).
  def configuration(files, filtered: false)
    inclusions = double("inclusions", empty?: !filtered)
    double("configuration", files_to_run: files, filter_manager: double("filter manager", inclusions: inclusions))
  end

  describe CoverageGate::LcovFormatter do
    it "writes DA records for relevant lines and BRDA records on each branch's report line" do
      file = source_file.new(
        "/repo/web/lib/example.rb",
        [line(1, nil), line(2, 3), line(3, 0), line(4, 1).tap(&:skipped!)],
        [branch(3, 2), branch(3, 0, type: :else), branch(6, 1, inline: true), branch(9, 0).tap(&:skipped!)],
      )

      expected = <<~LCOV
        TN:
        SF:/repo/web/lib/example.rb
        DA:2,3
        DA:3,0
        BRDA:2,0,0,2
        BRDA:2,0,1,0
        BRDA:6,0,0,1
        BRF:3
        BRH:2
        LF:2
        LH:1
        end_of_record
      LCOV

      expect(described_class.render([file])).to eq(expected)
    end

    it "writes lcov.info into SimpleCov's coverage directory" do
      Dir.mktmpdir do |dir|
        allow(SimpleCov).to receive(:coverage_path).and_return(dir)
        result = instance_double(SimpleCov::Result, files: [source_file.new("/a.rb", [line(1, 1)], [])])

        path = described_class.new.format(result)

        expect(path).to eq(File.join(dir, "lcov.info"))
        expect(File.read(path)).to eq("TN:\nSF:/a.rb\nDA:1,1\nBRF:0\nBRH:0\nLF:1\nLH:1\nend_of_record\n")
      end
    end
  end

  describe ".full_suite?" do
    around do |example|
      Dir.mktmpdir do |dir|
        @spec_dir = dir
        FileUtils.mkdir_p(File.join(dir, "nested"))
        FileUtils.mkdir_p(File.join(dir, "support"))
        %w[a_spec.rb nested/b_spec.rb support/helper.rb].each { |name| File.write(File.join(dir, name), "") }
        example.run
      end
    end

    let(:all_specs) { [File.join(@spec_dir, "nested", "b_spec.rb"), File.join(@spec_dir, "a_spec.rb")] }

    it "is true when every spec file runs without an inclusion filter" do
      expect(described_class.full_suite?(configuration(all_specs), @spec_dir)).to be(true)
    end

    it "is false when only some spec files run" do
      expect(described_class.full_suite?(configuration(all_specs.take(1)), @spec_dir)).to be(false)
    end

    it "is false when an inclusion filter narrows the run" do
      expect(described_class.full_suite?(configuration(all_specs, filtered: true), @spec_dir)).to be(false)
    end

    it "sets the floor only on a full-suite run without COVERAGE_GATE" do
      simplecov = double("SimpleCov")
      expect(simplecov).to receive(:minimum_coverage).with(line: 90.0, branch: 80.0).once

      full = described_class.apply_floor(simplecov, configuration(all_specs), spec_dir: @spec_dir, line: 90.0, branch: 80.0, env: {})
      partial = described_class.apply_floor(simplecov, configuration(all_specs.take(1)), spec_dir: @spec_dir, line: 90.0, branch: 80.0, env: {})
      other = described_class.apply_floor(simplecov, configuration(all_specs.take(1)), spec_dir: @spec_dir, line: 90.0, branch: 80.0, env: { "COVERAGE_GATE" => "0" })

      expect([full, partial, other]).to eq([true, false, false])
    end

    it "sets the floor on a partial run when COVERAGE_GATE=1, as CI runs, so CI fails closed" do
      simplecov = double("SimpleCov")
      expect(simplecov).to receive(:minimum_coverage).with(line: 90.0, branch: 80.0).twice

      partial = described_class.apply_floor(simplecov, configuration(all_specs.take(1)), spec_dir: @spec_dir, line: 90.0, branch: 80.0, env: { "COVERAGE_GATE" => "1" })
      filtered = described_class.apply_floor(simplecov, configuration(all_specs, filtered: true), spec_dir: @spec_dir, line: 90.0, branch: 80.0, env: { "COVERAGE_GATE" => "1" })

      expect([partial, filtered]).to eq([true, true])
    end
  end
end
