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

require "spec_helper"
require "sqlite3"

RSpec.describe PotatoMesh::App::Instances do
  let(:application_class) { PotatoMesh::Application }
  let(:week_seconds) { PotatoMesh::Config.week_seconds }

  # Execute the provided block with a configured SQLite connection.
  #
  # @param readonly [Boolean] whether the connection should be read-only.
  # @yieldparam db [SQLite3::Database] configured database handle.
  # @return [void]
  def with_db(readonly: false)
    db = SQLite3::Database.new(PotatoMesh::Config.db_path, readonly: readonly)
    db.busy_timeout = PotatoMesh::Config.db_busy_timeout_ms
    db.execute("PRAGMA foreign_keys = ON")
    yield db
  ensure
    db&.close
  end

  before do
    FileUtils.mkdir_p(File.dirname(PotatoMesh::Config.db_path))
    application_class.init_db unless application_class.db_schema_present?
    with_db do |db|
      db.execute("DELETE FROM instances")
    end
  end

  describe ".load_instances_for_api" do
    it "only returns instances updated within the configured rolling window" do
      fixed_time = Time.utc(2025, 1, 15, 12, 0, 0)
      allow(Time).to receive(:now).and_return(fixed_time)

      application_class.ensure_self_instance_record!

      recent_timestamp = fixed_time.to_i - (week_seconds / 2)
      stale_timestamp = fixed_time.to_i - week_seconds - 60

      with_db do |db|
        db.execute(
          "INSERT INTO instances (id, domain, pubkey, last_update_time, is_private) VALUES (?, ?, ?, ?, ?)",
          [
            "recent-instance",
            "recent.mesh.test",
            PotatoMesh::Application::INSTANCE_PUBLIC_KEY_PEM,
            recent_timestamp,
            0,
          ],
        )
        db.execute(
          "INSERT INTO instances (id, domain, pubkey, last_update_time, is_private) VALUES (?, ?, ?, ?, ?)",
          [
            "stale-instance",
            "stale.mesh.test",
            PotatoMesh::Application::INSTANCE_PUBLIC_KEY_PEM,
            stale_timestamp,
            0,
          ],
        )
        db.execute(
          "INSERT INTO instances (id, domain, pubkey, is_private) VALUES (?, ?, ?, ?)",
          [
            "missing-instance",
            "missing.mesh.test",
            PotatoMesh::Application::INSTANCE_PUBLIC_KEY_PEM,
            0,
          ],
        )
      end

      payload = application_class.load_instances_for_api
      domains = payload.map { |row| row["domain"] }
      lower_bound = fixed_time.to_i - week_seconds

      expect(domains).to include("recent.mesh.test")
      expect(domains).to include(application_class.app_constant(:INSTANCE_DOMAIN))
      expect(domains).not_to include("stale.mesh.test")
      expect(domains).not_to include("missing.mesh.test")
      expect(payload.all? { |row| row["lastUpdateTime"] >= lower_bound }).to be(true)
    end
  end
end
