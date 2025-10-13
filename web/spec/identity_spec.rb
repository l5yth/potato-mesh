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
require "openssl"

RSpec.describe PotatoMesh::App::Identity do
  let(:harness_class) do
    Class.new do
      extend PotatoMesh::App::Identity
    end
  end

  describe ".load_or_generate_instance_private_key" do
    it "loads an existing key without generating a new one" do
      Dir.mktmpdir do |dir|
        key_path = File.join(dir, "config", "potato-mesh", "keyfile")
        FileUtils.mkdir_p(File.dirname(key_path))
        key = OpenSSL::PKey::RSA.new(2048)
        File.write(key_path, key.export)

        allow(PotatoMesh::Config).to receive(:keyfile_path).and_return(key_path)

        loaded_key, generated = harness_class.load_or_generate_instance_private_key

        expect(generated).to be(false)
        expect(loaded_key.to_pem).to eq(key.to_pem)
      end
    ensure
      allow(PotatoMesh::Config).to receive(:keyfile_path).and_call_original
    end
  end
end
