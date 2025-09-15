require 'simplecov'
SimpleCov.coverage_dir 'coverage-ruby'
SimpleCov.start do
  add_filter '/spec/'
end

require_relative '../test/support/create_db'
DB_PATH = File.join(__dir__, 'test.db')
create_test_db(DB_PATH)
ENV['MESH_DB'] = DB_PATH

require 'rack/test'
require 'rspec'

RSpec.configure do |config|
  config.include Rack::Test::Methods
end
