# frozen_string_literal: true

require "spec_helper"

RSpec.describe PotatoMesh::Config do
  describe ".federation_announcement_interval" do
    it "returns eight hours in seconds" do
      expect(described_class.federation_announcement_interval).to eq(8 * 60 * 60)
    end
  end
end
