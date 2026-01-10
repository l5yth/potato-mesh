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

RSpec.describe PotatoMesh::App::Meshtastic::Protobuf do
  def encode_varint(value)
    bytes = []
    remaining = value
    loop do
      byte = remaining & 0x7f
      remaining >>= 7
      if remaining.zero?
        bytes << byte
        break
      end
      bytes << (byte | 0x80)
    end
    bytes.pack("C*")
  end

  it "extracts a length-delimited field by number" do
    field_number = 3
    payload = "blob".b
    tag = (field_number << 3) | described_class::WIRE_TYPE_LENGTH_DELIMITED
    message = [tag].pack("C") + encode_varint(payload.bytesize) + payload

    extracted = described_class.extract_field_bytes(message, field_number)

    expect(extracted).to eq(payload)
  end

  it "returns nil when a varint is truncated" do
    field_number = 1
    tag = (field_number << 3) | described_class::WIRE_TYPE_VARINT
    message = [tag].pack("C") + [0x80].pack("C")

    extracted = described_class.extract_field_bytes(message, field_number)

    expect(extracted).to be_nil
  end

  it "parses portnum and payload from a data message" do
    portnum_tag = (1 << 3) | described_class::WIRE_TYPE_VARINT
    payload_tag = (2 << 3) | described_class::WIRE_TYPE_LENGTH_DELIMITED
    payload = "OK".b
    message = [
      portnum_tag,
    ].pack("C") + encode_varint(3) +
              [payload_tag].pack("C") + encode_varint(payload.bytesize) + payload

    data = described_class.parse_data(message)

    expect(data).to eq(portnum: 3, payload: payload)
  end

  it "returns nil when portnum is missing" do
    payload_tag = (2 << 3) | described_class::WIRE_TYPE_LENGTH_DELIMITED
    payload = "OK".b
    message = [payload_tag].pack("C") + encode_varint(payload.bytesize) + payload

    expect(described_class.parse_data(message)).to be_nil
  end

  it "returns nil when payload is missing" do
    portnum_tag = (1 << 3) | described_class::WIRE_TYPE_VARINT
    message = [portnum_tag].pack("C") + encode_varint(1)

    expect(described_class.parse_data(message)).to be_nil
  end

  it "rejects invalid varints that overflow" do
    invalid = ([0x80] * 10).pack("C*")

    expect(described_class.read_varint(invalid.bytes, 0)).to be_nil
  end

  it "skips 64-bit fields while searching for length-delimited bytes" do
    target_field = 3
    junk_tag = (1 << 3) | described_class::WIRE_TYPE_64BIT
    target_tag = (target_field << 3) | described_class::WIRE_TYPE_LENGTH_DELIMITED
    message = [junk_tag].pack("C") + ("\x00" * 8) +
              [target_tag].pack("C") + encode_varint(4) + "test"

    extracted = described_class.extract_field_bytes(message, target_field)

    expect(extracted).to eq("test")
  end

  it "skips 32-bit fields while searching for length-delimited bytes" do
    target_field = 4
    junk_tag = (2 << 3) | described_class::WIRE_TYPE_32BIT
    target_tag = (target_field << 3) | described_class::WIRE_TYPE_LENGTH_DELIMITED
    message = [junk_tag].pack("C") + ("\x00" * 4) +
              [target_tag].pack("C") + encode_varint(3) + "abc"

    extracted = described_class.extract_field_bytes(message, target_field)

    expect(extracted).to eq("abc")
  end

  it "returns nil on unsupported wire types" do
    bad_tag = (1 << 3) | 7
    message = [bad_tag].pack("C")

    expect(described_class.extract_field_bytes(message, 1)).to be_nil
  end

  it "returns nil when length-delimited field overruns payload" do
    tag = (1 << 3) | described_class::WIRE_TYPE_LENGTH_DELIMITED
    message = [tag].pack("C") + encode_varint(10) + "short"

    expect(described_class.extract_field_bytes(message, 1)).to be_nil
  end

  it "returns nil when length varint is missing" do
    tag = (1 << 3) | described_class::WIRE_TYPE_LENGTH_DELIMITED
    message = [tag].pack("C")

    expect(described_class.extract_field_bytes(message, 1)).to be_nil
  end
end
