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

module PotatoMesh
  module App
    module Routes
      # Admin routes for managing ingestor registrations.
      #
      # These endpoints require the ADMIN_TOKEN for authentication and are
      # only available when INGESTOR_MANAGEMENT=1 is set.
      module Admin
        # Register admin endpoints for ingestor management.
        #
        # @param app [Sinatra::Base] application instance receiving the routes.
        # @return [void]
        def self.registered(app)
          # Guard all admin routes to check if ingestor management is enabled
          app.before "/admin/*" do
            unless PotatoMesh::Config.ingestor_management_enabled?
              halt 404, { error: "not found" }.to_json
            end
          end

          # Validate admin token for all admin endpoints
          app.before "/admin/*" do
            require_admin_token!
          end

          # List all registered ingestors
          app.get "/admin/ingestors" do
            content_type :json
            include_inactive = params["include_inactive"] == "1"
            db = open_database(readonly: true)
            begin
              ingestors = list_ingestors(db, include_inactive: include_inactive)
              # Mask API keys in list view for security
              masked = ingestors.map do |ing|
                ing.merge("api_key" => mask_api_key(ing["api_key"]))
              end
              { ingestors: masked }.to_json
            ensure
              db&.close
            end
          end

          # Get a single ingestor by ID
          app.get "/admin/ingestors/:id" do
            content_type :json
            id = string_or_nil(params["id"])
            halt 400, { error: "missing ingestor id" }.to_json unless id

            db = open_database(readonly: true)
            begin
              ingestor = find_ingestor_by_id(db, id)
              halt 404, { error: "ingestor not found" }.to_json unless ingestor
              # Mask API key for security
              ingestor["api_key"] = mask_api_key(ingestor["api_key"])
              ingestor.to_json
            ensure
              db&.close
            end
          end

          # Create a new ingestor registration
          app.post "/admin/ingestors" do
            content_type :json
            begin
              data = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end

            name = string_or_nil(data["name"])
            node_id = string_or_nil(data["node_id"])
            contact_email = string_or_nil(data["contact_email"])
            contact_matrix = string_or_nil(data["contact_matrix"])

            db = open_database
            begin
              ingestor = create_ingestor(
                db,
                name: name,
                node_id: node_id,
                contact_email: contact_email,
                contact_matrix: contact_matrix,
              )

              warn_log(
                "Created new ingestor",
                context: "admin.ingestors.create",
                ingestor_id: ingestor["id"],
                name: name,
                node_id: node_id,
              )

              # Return full API key only on creation
              status 201
              ingestor.to_json
            ensure
              db&.close
            end
          end

          # Update an existing ingestor
          app.patch "/admin/ingestors/:id" do
            content_type :json
            id = string_or_nil(params["id"])
            halt 400, { error: "missing ingestor id" }.to_json unless id

            begin
              data = JSON.parse(read_json_body)
            rescue JSON::ParserError
              halt 400, { error: "invalid JSON" }.to_json
            end

            db = open_database
            begin
              existing = find_ingestor_by_id(db, id)
              halt 404, { error: "ingestor not found" }.to_json unless existing

              # Build update parameters - only include fields that are present
              update_params = {}
              update_params[:name] = string_or_nil(data["name"]) if data.key?("name")
              update_params[:node_id] = string_or_nil(data["node_id"]) if data.key?("node_id")
              update_params[:contact_email] = string_or_nil(data["contact_email"]) if data.key?("contact_email")
              update_params[:contact_matrix] = string_or_nil(data["contact_matrix"]) if data.key?("contact_matrix")

              if update_params.empty?
                halt 400, { error: "no fields to update" }.to_json
              end

              success = update_ingestor(db, id, **update_params)
              halt 500, { error: "update failed" }.to_json unless success

              warn_log(
                "Updated ingestor",
                context: "admin.ingestors.update",
                ingestor_id: id,
                updated_fields: update_params.keys.join(","),
              )

              updated = find_ingestor_by_id(db, id)
              updated["api_key"] = mask_api_key(updated["api_key"])
              updated.to_json
            ensure
              db&.close
            end
          end

          # Regenerate API key for an ingestor
          app.post "/admin/ingestors/:id/regenerate-key" do
            content_type :json
            id = string_or_nil(params["id"])
            halt 400, { error: "missing ingestor id" }.to_json unless id

            db = open_database
            begin
              existing = find_ingestor_by_id(db, id)
              halt 404, { error: "ingestor not found" }.to_json unless existing

              new_key = regenerate_ingestor_api_key(db, id)
              halt 500, { error: "key regeneration failed" }.to_json unless new_key

              warn_log(
                "Regenerated ingestor API key",
                context: "admin.ingestors.regenerate_key",
                ingestor_id: id,
                name: existing["name"],
              )

              # Return the new key - this is the only time it will be visible
              { id: id, api_key: new_key }.to_json
            ensure
              db&.close
            end
          end

          # Deactivate an ingestor (soft delete)
          app.post "/admin/ingestors/:id/deactivate" do
            content_type :json
            id = string_or_nil(params["id"])
            halt 400, { error: "missing ingestor id" }.to_json unless id

            db = open_database
            begin
              existing = find_ingestor_by_id(db, id)
              halt 404, { error: "ingestor not found" }.to_json unless existing

              success = deactivate_ingestor(db, id)
              halt 500, { error: "deactivation failed" }.to_json unless success

              warn_log(
                "Deactivated ingestor",
                context: "admin.ingestors.deactivate",
                ingestor_id: id,
                name: existing["name"],
              )

              { status: "deactivated", id: id }.to_json
            ensure
              db&.close
            end
          end

          # Reactivate an ingestor
          app.post "/admin/ingestors/:id/reactivate" do
            content_type :json
            id = string_or_nil(params["id"])
            halt 400, { error: "missing ingestor id" }.to_json unless id

            db = open_database
            begin
              existing = find_ingestor_by_id(db, id)
              halt 404, { error: "ingestor not found" }.to_json unless existing

              success = reactivate_ingestor(db, id)
              halt 500, { error: "reactivation failed" }.to_json unless success

              warn_log(
                "Reactivated ingestor",
                context: "admin.ingestors.reactivate",
                ingestor_id: id,
                name: existing["name"],
              )

              { status: "reactivated", id: id }.to_json
            ensure
              db&.close
            end
          end

          # Permanently delete an ingestor
          app.delete "/admin/ingestors/:id" do
            content_type :json
            id = string_or_nil(params["id"])
            halt 400, { error: "missing ingestor id" }.to_json unless id

            db = open_database
            begin
              existing = find_ingestor_by_id(db, id)
              halt 404, { error: "ingestor not found" }.to_json unless existing

              success = delete_ingestor(db, id)
              halt 500, { error: "deletion failed" }.to_json unless success

              warn_log(
                "Deleted ingestor",
                context: "admin.ingestors.delete",
                ingestor_id: id,
                name: existing["name"],
              )

              { status: "deleted", id: id }.to_json
            ensure
              db&.close
            end
          end
        end
      end
    end
  end
end
