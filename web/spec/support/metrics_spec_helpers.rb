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

# Exposition readers shared by the specs that read +/metrics+
# (+prometheus_spec.rb+, +metrics_routes_spec.rb+, +field_limits_spec.rb+).
# The scrape helpers request +/metrics+ through Rack::Test.
module MetricsSpecHelpers
  # Sample lines of a text exposition, comments excluded.
  #
  # @param text [String] Prometheus text exposition.
  # @return [Array<String>] sample lines.
  def sample_lines(text)
    text.each_line.map(&:chomp).reject { |line| line.start_with?("#") }
  end

  # Sample lines of one metric family in a text exposition.
  #
  # @param text [String] Prometheus text exposition.
  # @param family [String] metric name; a longer name sharing its prefix is
  #   another family.
  # @param node_id [String, nil] keep only this node's samples when given.
  # @return [Array<String>] sample lines, comments excluded.
  def family_samples(text, family, node_id = nil)
    sample_lines(text).select do |line|
      (line.start_with?("#{family}{") || line.start_with?("#{family} ")) &&
        (node_id.nil? || line.include?(%(node="#{node_id}")))
    end
  end

  # Sample lines labelled with one node id, of every family.
  #
  # @param text [String] Prometheus text exposition.
  # @param node_id [String] canonical node id.
  # @return [Array<String>] sample lines for that node, comments excluded.
  def node_samples(text, node_id)
    sample_lines(text).select { |line| line.include?(%(node="#{node_id}")) }
  end

  # Scrape +/metrics+ through the app and expect it to answer.
  #
  # @return [String] text exposition.
  def scraped_metrics
    get "/metrics"
    expect(last_response.status).to eq(200)
    last_response.body
  end

  # Scrape +/metrics+ and keep the samples of one family.
  #
  # @param family [String] metric name.
  # @param node_id [String, nil] keep only this node's samples when given.
  # @return [Array<String>] sample lines, comments excluded.
  def scraped_samples(family, node_id = nil)
    family_samples(scraped_metrics, family, node_id)
  end

  # Scrape +/metrics+ and keep the samples labelled with one node id.
  #
  # @param node_id [String] canonical node id.
  # @return [Array<String>] sample lines for that node, comments excluded.
  def scraped_node_samples(node_id)
    node_samples(scraped_metrics, node_id)
  end
end
