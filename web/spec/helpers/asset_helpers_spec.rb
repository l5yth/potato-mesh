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

require "spec_helper"

# Unit coverage for the asset cache-busting helper (SPEC AV1, AV2). The helper
# is exercised in isolation through a bare harness class so the assertion does
# not depend on the live git-derived version string.
RSpec.describe PotatoMesh::App::Helpers do
  let(:harness_class) do
    Class.new do
      include PotatoMesh::App::Helpers
    end
  end

  subject(:helper) { harness_class.new }

  # ---------------------------------------------------------------------------
  # asset_url
  # ---------------------------------------------------------------------------
  describe "#asset_url" do
    before do
      # +app_constant+ is a real instance method (from config_helpers), so this
      # partial double satisfies +verify_partial_doubles+.
      allow(helper).to receive(:app_constant).with(:APP_VERSION).and_return("1.2.3")
    end

    it "appends the application version as a cache-busting query to a JS path" do
      expect(helper.asset_url("/assets/js/app/index.js")).to eq("/assets/js/app/index.js?v=1.2.3")
    end

    it "appends the application version to a CSS path" do
      expect(helper.asset_url("/assets/styles/base.css")).to eq("/assets/styles/base.css?v=1.2.3")
    end

    it "reads the cache key from the APP_VERSION constant" do
      expect(helper.asset_url("/assets/js/theme.js")).to end_with("?v=1.2.3")
    end
  end
end
