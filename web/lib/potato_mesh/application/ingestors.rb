# Copyright © 2025-26 l5yth, apo-mak & contributors
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

require "securerandom"

module PotatoMesh
  module App
    # Helper methods for managing ingestor registrations and API keys.
    #
    # Ingestors are external data collectors that feed mesh data into the
    # PotatoMesh instance. Each ingestor receives a unique API key that
    # can be used for authentication instead of the shared API_TOKEN.
    module Ingestors
      # Generate a new secure API key for ingestor authentication.
      #
      # @return [String] a UUID-format API key.
      def generate_ingestor_api_key
        SecureRandom.uuid
      end

      # Generate a unique ingestor identifier.
      #
      # @return [String] a UUID-format identifier.
      def generate_ingestor_id
        SecureRandom.uuid
      end

      # Create a new ingestor registration in the database.
      #
      # @param db [SQLite3::Database] database connection.
      # @param name [String, nil] friendly name for the ingestor.
      # @param node_id [String, nil] associated mesh node identifier.
      # @param contact_email [String, nil] contact email address.
      # @param contact_matrix [String, nil] Matrix username for contact.
      # @return [Hash] the created ingestor record with api_key.
      def create_ingestor(db, name: nil, node_id: nil, contact_email: nil, contact_matrix: nil)
        id = generate_ingestor_id
        api_key = generate_ingestor_api_key
        created_at = Time.now.to_i

        with_busy_retry do
          db.execute(
            <<~SQL,
            INSERT INTO ingestors (id, api_key, name, node_id, contact_email, contact_matrix, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          SQL
            [id, api_key, name, node_id, contact_email, contact_matrix, created_at],
          )
        end

        {
          "id" => id,
          "api_key" => api_key,
          "name" => name,
          "node_id" => node_id,
          "contact_email" => contact_email,
          "contact_matrix" => contact_matrix,
          "version" => nil,
          "last_request_time" => nil,
          "request_count" => 0,
          "created_at" => created_at,
          "is_active" => true,
        }
      end

      # Find an ingestor by its API key.
      #
      # @param db [SQLite3::Database] database connection.
      # @param api_key [String] the API key to look up.
      # @return [Hash, nil] the ingestor record or nil if not found.
      def find_ingestor_by_api_key(db, api_key)
        return nil if api_key.nil? || api_key.empty?

        row = with_busy_retry do
          db.execute(
            <<~SQL,
            SELECT id, api_key, name, node_id, contact_email, contact_matrix,
                   version, last_request_time, request_count, created_at, is_active
            FROM ingestors
            WHERE api_key = ? AND is_active = 1
          SQL
            [api_key],
          ).first
        end

        return nil unless row

        {
          "id" => row[0],
          "api_key" => row[1],
          "name" => row[2],
          "node_id" => row[3],
          "contact_email" => row[4],
          "contact_matrix" => row[5],
          "version" => row[6],
          "last_request_time" => row[7],
          "request_count" => row[8],
          "created_at" => row[9],
          "is_active" => row[10] == 1,
        }
      end

      # Find an ingestor by its identifier.
      #
      # @param db [SQLite3::Database] database connection.
      # @param id [String] the ingestor identifier.
      # @return [Hash, nil] the ingestor record or nil if not found.
      def find_ingestor_by_id(db, id)
        return nil if id.nil? || id.empty?

        row = with_busy_retry do
          db.execute(
            <<~SQL,
            SELECT id, api_key, name, node_id, contact_email, contact_matrix,
                   version, last_request_time, request_count, created_at, is_active
            FROM ingestors
            WHERE id = ?
          SQL
            [id],
          ).first
        end

        return nil unless row

        {
          "id" => row[0],
          "api_key" => row[1],
          "name" => row[2],
          "node_id" => row[3],
          "contact_email" => row[4],
          "contact_matrix" => row[5],
          "version" => row[6],
          "last_request_time" => row[7],
          "request_count" => row[8],
          "created_at" => row[9],
          "is_active" => row[10] == 1,
        }
      end

      # List all registered ingestors.
      #
      # @param db [SQLite3::Database] database connection.
      # @param include_inactive [Boolean] whether to include deactivated ingestors.
      # @return [Array<Hash>] list of ingestor records.
      def list_ingestors(db, include_inactive: false)
        query = <<~SQL
          SELECT id, api_key, name, node_id, contact_email, contact_matrix,
                 version, last_request_time, request_count, created_at, is_active
          FROM ingestors
          #{include_inactive ? "" : "WHERE is_active = 1"}
          ORDER BY created_at DESC
        SQL

        rows = with_busy_retry { db.execute(query) }

        rows.map do |row|
          {
            "id" => row[0],
            "api_key" => row[1],
            "name" => row[2],
            "node_id" => row[3],
            "contact_email" => row[4],
            "contact_matrix" => row[5],
            "version" => row[6],
            "last_request_time" => row[7],
            "request_count" => row[8],
            "created_at" => row[9],
            "is_active" => row[10] == 1,
          }
        end
      end

      # Update the last request timestamp and version for an ingestor.
      #
      # @param db [SQLite3::Database] database connection.
      # @param api_key [String] the ingestor's API key.
      # @param version [String, nil] the ingestor version reported in headers.
      # @return [void]
      def record_ingestor_request(db, api_key, version: nil)
        return if api_key.nil? || api_key.empty?

        now = Time.now.to_i

        with_busy_retry do
          if version
            db.execute(
              <<~SQL,
              UPDATE ingestors
              SET last_request_time = ?, request_count = request_count + 1, version = ?
              WHERE api_key = ?
            SQL
              [now, version, api_key],
            )
          else
            db.execute(
              <<~SQL,
              UPDATE ingestors
              SET last_request_time = ?, request_count = request_count + 1
              WHERE api_key = ?
            SQL
              [now, api_key],
            )
          end
        end
      end

      # Update an ingestor's registration details.
      #
      # @param db [SQLite3::Database] database connection.
      # @param id [String] the ingestor identifier.
      # @param name [String, nil] new friendly name.
      # @param node_id [String, nil] new associated node identifier.
      # @param contact_email [String, nil] new contact email.
      # @param contact_matrix [String, nil] new Matrix username.
      # @return [Boolean] true if the update succeeded.
      def update_ingestor(db, id, name: nil, node_id: nil, contact_email: nil, contact_matrix: nil)
        return false if id.nil? || id.empty?

        updates = []
        params = []

        unless name.nil?
          updates << "name = ?"
          params << name
        end

        unless node_id.nil?
          updates << "node_id = ?"
          params << node_id
        end

        unless contact_email.nil?
          updates << "contact_email = ?"
          params << contact_email
        end

        unless contact_matrix.nil?
          updates << "contact_matrix = ?"
          params << contact_matrix
        end

        return false if updates.empty?

        params << id

        with_busy_retry do
          db.execute(
            "UPDATE ingestors SET #{updates.join(", ")} WHERE id = ?",
            params,
          )
        end

        db.changes.positive?
      end

      # Regenerate the API key for an ingestor.
      #
      # @param db [SQLite3::Database] database connection.
      # @param id [String] the ingestor identifier.
      # @return [String, nil] the new API key or nil if ingestor not found.
      def regenerate_ingestor_api_key(db, id)
        return nil if id.nil? || id.empty?

        new_key = generate_ingestor_api_key

        with_busy_retry do
          db.execute(
            "UPDATE ingestors SET api_key = ? WHERE id = ?",
            [new_key, id],
          )
        end

        db.changes.positive? ? new_key : nil
      end

      # Deactivate an ingestor (soft delete).
      #
      # @param db [SQLite3::Database] database connection.
      # @param id [String] the ingestor identifier.
      # @return [Boolean] true if the deactivation succeeded.
      def deactivate_ingestor(db, id)
        return false if id.nil? || id.empty?

        with_busy_retry do
          db.execute(
            "UPDATE ingestors SET is_active = 0 WHERE id = ?",
            [id],
          )
        end

        db.changes.positive?
      end

      # Reactivate a previously deactivated ingestor.
      #
      # @param db [SQLite3::Database] database connection.
      # @param id [String] the ingestor identifier.
      # @return [Boolean] true if the reactivation succeeded.
      def reactivate_ingestor(db, id)
        return false if id.nil? || id.empty?

        with_busy_retry do
          db.execute(
            "UPDATE ingestors SET is_active = 1 WHERE id = ?",
            [id],
          )
        end

        db.changes.positive?
      end

      # Permanently delete an ingestor from the database.
      #
      # @param db [SQLite3::Database] database connection.
      # @param id [String] the ingestor identifier.
      # @return [Boolean] true if the deletion succeeded.
      def delete_ingestor(db, id)
        return false if id.nil? || id.empty?

        with_busy_retry do
          db.execute("DELETE FROM ingestors WHERE id = ?", [id])
        end

        db.changes.positive?
      end

      # Check if the provided token matches any active ingestor API key.
      #
      # @param db [SQLite3::Database] database connection.
      # @param token [String] the token to validate.
      # @return [Hash, nil] the ingestor record if valid, nil otherwise.
      def validate_ingestor_token(db, token)
        return nil if token.nil? || token.empty?

        find_ingestor_by_api_key(db, token)
      end
    end
  end
end
