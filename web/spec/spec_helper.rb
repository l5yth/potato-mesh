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
require "simplecov_json_formatter"
require_relative "support/coverage_gate"

SimpleCov.formatters = SimpleCov::Formatter::MultiFormatter.new(
  [
    SimpleCov::Formatter::SimpleFormatter,
    SimpleCov::Formatter::HTMLFormatter,
    SimpleCov::Formatter::JSONFormatter,
    CoverageGate::LcovFormatter,
  ],
)

# SimpleCov measures web/ only. tests/cypher.rb and tests/rainbow.rb are
# offline developer scripts outside it, left out of the floor (SPEC CV7).
SimpleCov.start do
  enable_coverage :branch
  add_filter "/spec/"
end

require "tmpdir"
require "fileutils"
require_relative "support/suite_tmpdir"

ENV["RACK_ENV"] = "test"
ENV["INSTANCE_DOMAIN"] ||= "spec.mesh.test"

# The run's one temporary directory: TMPDIR points at its tmp directory, and
# an at_exit hook removes it; a SIGKILL or a second INT leaves it behind
# (SPEC TD1).
SPEC_TMPDIR = SuiteTmpdir.create!
ENV["XDG_DATA_HOME"] = File.join(SPEC_TMPDIR, "xdg-data")
ENV["XDG_CONFIG_HOME"] = File.join(SPEC_TMPDIR, "xdg-config")

FileUtils.mkdir_p(ENV["XDG_DATA_HOME"])
FileUtils.mkdir_p(ENV["XDG_CONFIG_HOME"])

require_relative "../app"

require "rack/test"
require "rspec"

# SPEC CV1, CV2, DD8: a full-suite run, and any run with COVERAGE_GATE=1 (CI),
# exits non-zero below these floors: the lowest of five runs on 2026-10-16,
# after the dead-code deletion (98.922% and 89.199%), less 0.1 point,
# truncated to two decimals, the precision SimpleCov compares at. Raise them
# by the same rule as coverage grows; never lower them.
CoverageGate.apply_floor(SimpleCov, RSpec.configuration, spec_dir: __dir__, line: 98.82, branch: 89.09)

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end

  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end

  config.shared_context_metadata_behavior = :apply_to_host_groups

  config.include Rack::Test::Methods

  # Federation keeps process-wide peer state: the fetch cooldown, backoff and
  # revalidation store per host, and the registrations in flight. Ingest
  # keeps the windows of the collision-warning limiter (SPEC KC5). Every
  # example starts without them.
  config.before do
    PotatoMesh::Application.clear_federation_crawl_state!
    PotatoMesh::App::DataProcessing.collision_warning_limiter.reset!
  end

  # A spec that leaves anything in the suite's TMPDIR fails the run; the
  # at_exit hook removes SPEC_TMPDIR either way (SPEC TD2).
  config.after(:suite) do
    SuiteTmpdir.check!(SuiteTmpdir.tmp_path(SPEC_TMPDIR))
  end
end
