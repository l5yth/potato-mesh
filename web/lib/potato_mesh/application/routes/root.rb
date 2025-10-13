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
      module Root
        def self.registered(app)
          app.get "/favicon.ico" do
            cache_control :public, max_age: PotatoMesh::Config.week_seconds
            ico_path = File.join(settings.public_folder, "favicon.ico")
            if File.file?(ico_path)
              send_file ico_path, type: "image/x-icon"
            else
              send_file File.join(settings.public_folder, "potatomesh-logo.svg"), type: "image/svg+xml"
            end
          end

          app.get "/potatomesh-logo.svg" do
            path = File.expand_path("potatomesh-logo.svg", settings.public_folder)
            settings.logger&.info("logo_path=#{path} exist=#{File.exist?(path)} file=#{File.file?(path)}")
            halt 404, "Not Found" unless File.exist?(path) && File.readable?(path)

            content_type "image/svg+xml"
            last_modified File.mtime(path)
            cache_control :public, max_age: 3600
            send_file path
          end

          app.get "/" do
            meta = meta_configuration
            config = frontend_app_config

            raw_theme = request.cookies["theme"]
            theme = %w[dark light].include?(raw_theme) ? raw_theme : "dark"
            if raw_theme != theme
              response.set_cookie("theme", value: theme, path: "/", max_age: 60 * 60 * 24 * 7, same_site: :lax)
            end

            erb :index, locals: {
                          site_name: meta[:name],
                          meta_title: meta[:title],
                          meta_name: meta[:name],
                          meta_description: meta[:description],
                          default_channel: sanitized_channel,
                          default_frequency: sanitized_frequency,
                          map_center_lat: PotatoMesh::Config.map_center_lat,
                          map_center_lon: PotatoMesh::Config.map_center_lon,
                          max_node_distance_km: PotatoMesh::Config.max_distance_km,
                          contact_link: sanitized_contact_link,
                          contact_label: sanitized_contact_label,
                          version: app_constant(:APP_VERSION),
                          private_mode: private_mode?,
                          refresh_interval_seconds: PotatoMesh::Config.refresh_interval_seconds,
                          app_config_json: JSON.generate(config),
                          initial_theme: theme,
                        }
          end

          app.get "/metrics" do
            content_type ::Prometheus::Client::Formats::Text::CONTENT_TYPE
            ::Prometheus::Client::Formats::Text.marshal(::Prometheus::Client.registry)
          end
        end
      end
    end
  end
end
