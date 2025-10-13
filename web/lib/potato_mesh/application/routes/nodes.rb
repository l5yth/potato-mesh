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
      # Routes serving HTML node detail pages.
      module Nodes
        # Register the node detail endpoint with the Sinatra application.
        #
        # @param app [Sinatra::Base] application instance.
        # @return [void]
        def self.registered(app)
          app.get "/node/:id" do
            node_ref = params[:id]
            halt 404, "Not Found" if node_ref.nil? || node_ref.to_s.strip.empty?

            node = find_node(node_ref)
            halt 404, "Not Found" unless node

            meta = meta_configuration
            theme = resolve_theme_from_cookie(request: request, response: response)
            short_name = PotatoMesh::Sanitizer.string_or_nil(node["short_name"]) || node["node_id"]
            long_name = PotatoMesh::Sanitizer.string_or_nil(node["long_name"]) || ""
            role = canonical_role_key(node["role"])

            badge_html = short_name_label_html(short_name)
            color = role_color(role)
            page_title = [short_name, meta[:name]].compact.reject(&:empty?).join(" – ")

            erb :nodes, locals: {
                          page_title: page_title,
                          site_name: meta[:name],
                          long_name_text: long_name,
                          long_name_title: long_name,
                          short_name_badge_html: badge_html,
                          role_color: color,
                          initial_theme: theme,
                        }
          end
        end
      end
    end
  end
end
