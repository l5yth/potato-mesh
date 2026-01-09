require "base64"
require "meshtastic"
require "openssl"

channel_name = "BerlinMesh"

# === Inputs from your packet ===
cipher_b64 = "Q1R7tgI5yXzMXu/3"
psk_b64 = "Nmh7EooP2Tsc+7pvPwXLcEDDuYhk+fBo2GLnbA1Y1sg="
packet_id = 3_915_687_257
from_id = "!9e95cf60"
channel = 35

# === Decode key and ciphertext ===
key = Base64.decode64(psk_b64)       # 32 bytes -> AES-256
ciphertext = Base64.decode64(cipher_b64)

# === Derive numeric node id from Meshtastic-style string ===
hex_str = from_id.sub(/^!/, "")          # "9e95cf60"
from_node = hex_str.to_i(16)               # 0x9e95cf60

# === Build nonce exactly like Meshtastic CryptoEngine ===
# Little-endian 64-bit packet ID + little-endian 32-bit node ID + 4 zero bytes
nonce = [packet_id].pack("Q<")            # uint64, little-endian
nonce += [from_node].pack("L<")            # uint32, little-endian
nonce += "\x00" * 4                        # extraNonce == 0 for PSK channel msgs

raise "Nonce must be 16 bytes" unless nonce.bytesize == 16
raise "Key must be 32 bytes" unless key.bytesize == 32

# === AES-256-CTR decrypt ===
cipher = OpenSSL::Cipher.new("aes-256-ctr")
cipher.decrypt
cipher.key = key
cipher.iv = nonce

plaintext = cipher.update(ciphertext) + cipher.final

# At this point `plaintext` is the raw Meshtastic protobuf payload
plaintext = plaintext.bytes.pack("C*")
data = Meshtastic::Data.decode(plaintext)
msg = data.payload.dup.force_encoding("UTF-8")
puts msg

# Gets channel number from name and psk
def channel_hash(name, psk_b64)
  name_bytes = name.b          # UTF-8 bytes
  psk_bytes = Base64.decode64(psk_b64)

  hn = name_bytes.bytes.reduce(0) { |acc, b| acc ^ b }   # XOR over name
  hp = psk_bytes.bytes.reduce(0) { |acc, b| acc ^ b }    # XOR over PSK

  (hn ^ hp) & 0xFF
end

channel_h = channel_hash(channel_name, psk_b64)
puts channel_h
puts channel == channel_h
