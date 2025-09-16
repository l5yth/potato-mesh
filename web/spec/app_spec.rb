# frozen_string_literal: true

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
