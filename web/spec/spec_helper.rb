# Copyright (C) 2025 l5yth
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

SimpleCov.formatters = SimpleCov::Formatter::MultiFormatter.new(
  [
    SimpleCov::Formatter::SimpleFormatter,
    SimpleCov::Formatter::HTMLFormatter,
    SimpleCov::Formatter::JSONFormatter,
  ],
)

SimpleCov.start do
  enable_coverage :branch
  add_filter "/spec/"
end

require "tmpdir"
require "fileutils"

ENV["RACK_ENV"] = "test"
ENV["INSTANCE_DOMAIN"] ||= "spec.mesh.test"

SPEC_TMPDIR = Dir.mktmpdir("potato-mesh-spec-")
ENV["XDG_DATA_HOME"] = File.join(SPEC_TMPDIR, "xdg-data")
ENV["XDG_CONFIG_HOME"] = File.join(SPEC_TMPDIR, "xdg-config")

FileUtils.mkdir_p(ENV["XDG_DATA_HOME"])
FileUtils.mkdir_p(ENV["XDG_CONFIG_HOME"])

require_relative "../app"

require "rack/test"
require "rspec"

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end

  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end

  config.shared_context_metadata_behavior = :apply_to_host_groups

  config.include Rack::Test::Methods

  config.after(:suite) do
    FileUtils.remove_entry(SPEC_TMPDIR) if File.directory?(SPEC_TMPDIR)
  end
end
