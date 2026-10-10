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

require "json"
require "sqlite3"

# Helpers shared by the ingest specs that post through the token-guarded
# routes and read the spec database back (+field_limits_spec.rb+,
# +ingest_bounds_spec.rb+).  The including group defines +auth_headers+;
# +Rack::Test::Methods+ comes from the spec helper.
module IngestSpecHelpers
  # Yield a handle on the spec database, rows as hashes, and close it.
  #
  # @yieldparam db [SQLite3::Database] open database handle.
  # @return [Object] the block's result.
  def with_db
    db = SQLite3::Database.new(PotatoMesh::Config.db_path)
    db.results_as_hash = true
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    yield db
  ensure
    db&.close
  end

  # The first column of the first row +sql+ selects.
  #
  # @param sql [String] query.
  # @param params [Array] bind values.
  # @return [Object, nil] the value, or nil without a row.
  def db_value(sql, params = [])
    with_db { |db| db.get_first_value(sql, params) }
  end

  # The first row +sql+ selects, as a hash of its columns.
  #
  # @param sql [String] query.
  # @param params [Array] bind values.
  # @return [Hash, nil] the row, or nil without one.
  def db_row(sql, params = [])
    with_db { |db| db.get_first_row(sql, params) }
  end

  # Every row +sql+ selects, each as a hash of its columns.
  #
  # @param sql [String] query.
  # @param params [Array] bind values.
  # @return [Array<Hash>] the rows.
  def db_rows(sql, params = [])
    with_db { |db| db.execute(sql, params) }
  end

  # POST +body+ as JSON to +path+ and expect the route to accept it.
  #
  # @param path [String] ingest route.
  # @param body [Object] request body.
  # @return [void]
  def post_ok(path, body)
    post path, body.to_json, auth_headers
    expect(last_response.status).to eq(201), "#{path} answered #{last_response.status}: #{last_response.body}"
  end
end
