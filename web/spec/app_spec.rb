# frozen_string_literal: true
# Copyright 2025 l5yth
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

require "spec_helper"
require "sqlite3"

RSpec.describe "Potato Mesh Sinatra app" do
  let(:app) { Sinatra::Application }

  describe "GET /" do
    it "responds successfully" do
      get "/"
      expect(last_response).to be_ok
    end
  end

  describe "database initialization" do
    it "creates the schema when booting" do
      expect(File).to exist(DB_PATH)

      db = SQLite3::Database.new(DB_PATH, readonly: true)
      tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes','messages')").flatten

      expect(tables).to include("nodes")
      expect(tables).to include("messages")
    ensure
      db&.close
    end
  end
end
