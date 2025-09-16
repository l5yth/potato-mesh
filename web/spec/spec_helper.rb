# frozen_string_literal: true

require "tmpdir"
require "fileutils"

ENV["RACK_ENV"] = "test"

SPEC_TMPDIR = Dir.mktmpdir("potato-mesh-spec-")
ENV["MESH_DB"] = File.join(SPEC_TMPDIR, "mesh.db")

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
