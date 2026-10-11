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
require "json"

RSpec.describe "PotatoMesh::App::AggregateWindows (SPEC RC1)" do
  let(:windows) { PotatoMesh::App::AggregateWindows }

  describe "canonical pairs" do
    it "lists the defaults and the pairs the frontend charts request" do
      expect(windows::TELEMETRY_PAIRS).to eq([[86_400, 300], [604_800, 3_600]])
      expect(windows::ACTIVITY_PAIRS).to eq([[86_400, 3_600], [604_800, 7_200]])
    end
  end

  describe ".nearest_pair" do
    {
      [3_600, 60] => [86_400, 300],
      [86_400, 300] => [86_400, 300],
      [86_400, 3_600] => [86_400, 300],
      [345_600, 300] => [86_400, 300],
      [345_601, 300] => [604_800, 3_600],
      [604_800, 300] => [604_800, 3_600],
      [2_419_200, 86_400] => [604_800, 3_600],
      # Equally near in window and in bucket: the pair listed first.
      [345_600, 1_950] => [86_400, 300],
    }.each do |(window, bucket), expected|
      it "maps #{window} s in #{bucket} s buckets to #{expected.join(" s in ")} s buckets for telemetry" do
        expect(windows.nearest_pair(windows::TELEMETRY_PAIRS, window, bucket)).to eq(expected)
      end
    end

    {
      [3_600, 600] => [86_400, 3_600],
      [604_800, 3_600] => [604_800, 7_200],
      [2_419_200, 86_400] => [604_800, 7_200],
      [345_600, 5_400] => [86_400, 3_600],
    }.each do |(window, bucket), expected|
      it "maps #{window} s in #{bucket} s buckets to #{expected.join(" s in ")} s buckets for activity" do
        expect(windows.nearest_pair(windows::ACTIVITY_PAIRS, window, bucket)).to eq(expected)
      end
    end

    it "decides on the bucket between pairs of one window" do
      pairs = [[86_400, 300], [86_400, 3_600]]
      expect(windows.nearest_pair(pairs, 86_400, 3_000)).to eq([86_400, 3_600])
      expect(windows.nearest_pair(pairs, 86_400, 1_000)).to eq([86_400, 300])
    end
  end

  describe ".bucket_floor" do
    it "rounds a timestamp down to the start of its bucket" do
      expect(windows.bucket_floor(1_791_000_123, 300)).to eq(1_791_000_000)
      expect(windows.bucket_floor(1_791_000_000, 300)).to eq(1_791_000_000)
      expect(windows.bucket_floor(1_791_007_199, 7_200)).to eq(1_791_000_000)
    end
  end

  describe ".series_since" do
    let(:series) do
      [
        { "bucket_start" => 100, "bucket_end" => 200, "total" => 1 },
        { "bucket_start" => 200, "bucket_end" => 300, "total" => 2 },
        { "bucket_start" => 300, "bucket_end" => 400, "total" => 3 },
      ].to_json
    end

    it "keeps the buckets that start at or after since" do
      expect(JSON.parse(windows.series_since(series, 200)).map { |b| b["total"] }).to eq([2, 3])
      expect(JSON.parse(windows.series_since(series, 100))).to eq(JSON.parse(series))
      expect(windows.series_since(series, 400)).to eq("[]")
    end
  end
end
