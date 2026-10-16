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

require "simplecov"

# Coverage gate of the Ruby suite (SPEC CV2): the LCOV report Codecov reads,
# with branch data, and the floor a full-suite run must hold.
module CoverageGate
  # SimpleCov formatter writing +coverage/lcov.info+: a +DA+ record for each
  # relevant line and a +BRDA+ record for each branch arm, filed on the line
  # SimpleCov reports the branch on (SPEC CV6).
  class LcovFormatter
    # Report file name inside SimpleCov's coverage directory.
    FILENAME = "lcov.info"

    # Write the report for +result+.
    #
    # @param result [SimpleCov::Result] the merged coverage result.
    # @return [String] path of the written report.
    def format(result)
      path = File.join(SimpleCov.coverage_path, FILENAME)
      File.write(path, self.class.render(result.files))
      path
    end

    # Render source files as LCOV records.
    #
    # @param files [Array<SimpleCov::SourceFile>] measured source files.
    # @return [String] one record per file.
    def self.render(files)
      files.map { |file| render_file(file) }.join
    end

    # Render one source file. Lines that never count and skipped lines or
    # branches are left out, as SimpleCov leaves them out of its totals.
    #
    # @param file [SimpleCov::SourceFile] a measured source file.
    # @return [String] its LCOV record.
    def self.render_file(file)
      lines = file.lines.reject { |line| line.never? || line.skipped? }
      branches = file.branches.reject(&:skipped?)
      record = +"TN:\nSF:#{file.filename}\n"
      lines.each { |line| record << "DA:#{line.line_number},#{line.coverage}\n" }
      branches.group_by(&:report_line).each do |line_number, arms|
        arms.each_with_index { |arm, index| record << "BRDA:#{line_number},0,#{index},#{arm.coverage}\n" }
      end
      record << "BRF:#{branches.size}\nBRH:#{branches.count(&:covered?)}\n"
      record << "LF:#{lines.size}\nLH:#{lines.count(&:covered?)}\nend_of_record\n"
    end
  end

  module_function

  # Whether this run loads every spec file under +spec_dir+ with no inclusion
  # filter (a line number, +-e+ or +--tag+). Only such a run measures what
  # the floor measures.
  #
  # @param configuration [RSpec::Core::Configuration] the running suite.
  # @param spec_dir [String] the +spec/+ directory.
  # @return [Boolean] true for a full-suite run.
  def full_suite?(configuration, spec_dir)
    expected = Dir[File.join(spec_dir, "**", "*_spec.rb")].map { |path| File.expand_path(path) }.sort
    running = configuration.files_to_run.map { |path| File.expand_path(path) }.sort
    running == expected && configuration.filter_manager.inclusions.empty?
  end

  # Make a run exit non-zero below the floor (SPEC CV2): a full-suite run, and
  # any run when +COVERAGE_GATE=1+. CI sets it, so a CI run that loads fewer
  # spec files fails closed. A local partial run keeps its exit status: its
  # coverage is not the suite's.
  #
  # @param simplecov [#minimum_coverage] SimpleCov, or a stand-in in specs.
  # @param configuration [RSpec::Core::Configuration] the running suite.
  # @param spec_dir [String] the +spec/+ directory.
  # @param line [Float] minimum line coverage, in percent.
  # @param branch [Float] minimum branch coverage, in percent.
  # @param env [Hash{String => String}] the environment, +ENV+ by default.
  # @return [Boolean] true when the floor applies to this run.
  def apply_floor(simplecov, configuration, spec_dir:, line:, branch:, env: ENV)
    return false unless env["COVERAGE_GATE"] == "1" || full_suite?(configuration, spec_dir)

    simplecov.minimum_coverage(line: line, branch: branch)
    true
  end
end
