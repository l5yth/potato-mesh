#!/usr/bin/env ruby
# frozen_string_literal: true

require "base64"
require "json"
require "csv"

# --- CONFIG --------------------------------------------------------

# The PSK you want. Here: public mesh, "AQ==" (0x01).
PSK_B64 = ENV.fetch("PSK_B64", "AQ==")

# 1000 potential channel candidate names for rainbow indices.
CANDIDATE_NAMES = %w[
  911 Admin ADMIN admin Alert Alpha AlphaNet Alpine Amateur Amazon Anaconda Aquila Arctic Ash Asteroid Astro Aurora Avalanche Backup Basalt Base Base1 Base2 BaseAlpha BaseBravo BaseCharlie Bavaria Beacon Bear BearNet Beat Berg Berlin BerlinMesh BerlinNet Beta BetaBerlin Bison Blackout Blizzard Bolt Bonfire Border Borealis Bravo BravoNet Breeze Bridge Bronze Burner Burrow Callisto Callsign Camp Campfire CampNet Caravan Carbon Carpet Central Chameleon Charlie Chat Checkpoint Checkpoint1 Checkpoint2 Cheetah City Clinic Cloud Cobra Collective Cologne Colony Comet Command Command1 Command2 CommandRoom Comms Comms1 Comms2 CommsNet Commune Control Control1 Control2 ControlRoom Convoy Copper Core Corvus Cosmos Courier Courier1 Courier2 CourierMesh CourierNet CQ CQ1 CQ2 Crow CrowNet DarkNet Dawn Daybreak Daylight Delta DeltaNet Demo DEMO DemoBerlin Den Desert Diamond Distress District Doctor Dortmund Downlink Downlink1 Draco Dragon DragonNet Dune Dusk Eagle EagleNet East EastStar Echo EchoMesh EchoNet Emergency emergency EMERGENCY EmergencyBerlin Epsilon Equinox Europa Falcon Field FieldNet Fire Fire1 Fire2 Firebird Firefly Fireline Fireteam Firewatch Flash Flock Fluss Fog Forest Fox FoxNet Foxtrot FoxtrotMesh FoxtrotNet Frankfurt Freedom Freq Freq1 Freq2 Friedrichshain Frontier Frost Galaxy Gale Gamma Ganymede Gecko General Ghost GhostNet Glacier Gold Granite Grassland Grid Grid1 Grid2 GridNet GridNorth GridSouth Griffin Group Ham HAM Hamburg HAMNet Harbor Harmony HarmonyNet Hawk HawkNet Haze Help Hessen Highway Hilltop Hinterland Hive Hospital HQ HQ1 HQ2 Hub Hub1 Hub2 Hydra Ice Io Iron Jaguar Jungle Jupiter Kiez Kilo KiloMesh KiloNet Kraken Kreuzberg Lava Layer Layer1 Layer2 Layer3 Leipzig Leopard Liberty LightNet Lightning Lima Link Lion Lizard LongFast LongSlow LoRa LoRaBerlin LoRaHessen LoRaMesh LoRaNet LoRaTest Main Mars Med Med1 Med2 Medic MediumFast MediumSlow Mercury Mesh Mesh1 Mesh2 Mesh3 Mesh4 Mesh5 MeshBerlin MeshCollective MeshCologne MeshFrankfurt MeshGrid MeshHamburg MeshHessen MeshLeipzig MeshMunich MeshNet MeshNetwork MeshRuhr Meshtastic MeshTest Meteor Metro Midnight Mirage Mist MoonNet Munich Müggelberg Nebula Nest Network Neukölln Nexus Nightfall NightMesh NightNet Nightshift NightshiftNet Nightwatch Node1 Node2 Node3 Node4 Node5 Nomad NomadMesh NomadNet Nomads Nord North NorthStar Oasis Obsidian Omega Operations OPERATIONS Ops Ops1 Ops2 OpsCenter OpsRoom Orbit Ost Outpost Outsider Owl Pack Packet PacketNet PacketRadio Panther Paramedic Path Peak Phantom Phoenix PhoenixNet Platinum Pluto Polar Prairie Prenzlauer PRIVATE Private Public Pulse PulseNet Python Quasar Radio Radio1 Radio2 RadioNet Rain Ranger Raven RavenNet Relay Relay1 Relay2 Repeater Repeater1 Repeater2 RepeaterHub Rescue Rescue1 Rescue2 RescueTeam Rhythm Ridge River Road Rock Router Router1 Router2 Rover Ruhr Runner Runners Safari Safe Safety Sahara Saturn Savanna Saxony Scout Sector Secure Sensor SENSOR Sensors SENSORS Shade Shadow ShadowNet Shelter Shelter1 Shelter2 ShortFast Sideband Sideband1 Sierra Signal Signal1 Signal2 SignalFire Signals Silver Smoke Snake Snow Solstice SOS Sos SOSBerlin South SouthStar Spectrum Squad StarNet Steel Stone Storm Storm1 Storm2 Stratum Stuttgart Summit SunNet Sunrise Sunset Sync SyncNet Syndicate Süd Tal Tango TangoMesh TangoNet Team Tempo Test TEST test TestBerlin Teufelsberg Thunder Tiger Titan Town Trail Tundra Tunnel Union Unit Universe Uplink Uplink1 Valley Venus Victor Village Viper Volcano Wald Wander Wanderer Wanderers Watch Watch1 Watch2 WaWi West WestStar Whisper Wind Wolf WolfDen WolfMesh WolfNet Wolfpack Wolves Woods Wyvern Zeta Zone Zone1 Zone2 Zone3 Zulu ZuluMesh ZuluNet
]

# Output filenames
CSV_OUT = ENV.fetch("CSV_OUT", "rainbow.csv")
JSON_OUT = ENV.fetch("JSON_OUT", "rainbow.json")

# --- HASH FUNCTION -------------------------------------------------

def xor_bytes(str_or_bytes)
  bytes = str_or_bytes.is_a?(String) ? str_or_bytes.bytes : str_or_bytes
  bytes.reduce(0) { |acc, b| (acc ^ b) & 0xFF }
end

def expanded_key(psk_b64)
  raw = Base64.decode64(psk_b64 || "")

  case raw.bytesize
  when 0
    # no encryption: length 0, xor = 0
    "".b
  when 1
    alias_index = raw.bytes.first
    alias_keys = {
      1 => [
        0xD4, 0xF1, 0xBB, 0x3A, 0x20, 0x29, 0x07, 0x59,
        0xF0, 0xBC, 0xFF, 0xAB, 0xCF, 0x4E, 0x69, 0x01,
      ].pack("C*"),
      2 => [
        0x38, 0x4B, 0xBC, 0xC0, 0x1D, 0xC0, 0x22, 0xD1,
        0x81, 0xBF, 0x36, 0xB8, 0x61, 0x21, 0xE1, 0xFB,
        0x96, 0xB7, 0x2E, 0x55, 0xBF, 0x74, 0x22, 0x7E,
        0x9D, 0x6A, 0xFB, 0x48, 0xD6, 0x4C, 0xB1, 0xA1,
      ].pack("C*"),
    }
    alias_keys.fetch(alias_index) { raise "Unknown PSK alias #{alias_index}" }
  when 2..15
    # pad to 16 (AES128)
    (raw.bytes + [0] * (16 - raw.bytesize)).pack("C*")
  when 16
    raw
  when 17..31
    # pad to 32 (AES256)
    (raw.bytes + [0] * (32 - raw.bytesize)).pack("C*")
  when 32
    raw
  else
    raise "PSK too long (#{raw.bytesize} bytes)"
  end
end

def channel_hash(name, psk_b64)
  effective_name = name.b
  key = expanded_key(psk_b64)

  h_name = xor_bytes(effective_name)
  h_key = xor_bytes(key)

  (h_name ^ h_key) & 0xFF
end

# --- BUILD RAINBOW TABLE -------------------------------------------

psk_b64 = PSK_B64
puts "Using PSK_B64=#{psk_b64.inspect}"

hash_to_names = Hash.new { |h, k| h[k] = [] }

CANDIDATE_NAMES.each do |name|
  h = channel_hash(name, psk_b64)
  hash_to_names[h] << name
end

# --- WRITE CSV (hash,name) -----------------------------------------

CSV.open(CSV_OUT, "w") do |csv|
  csv << %w[hash name]
  hash_to_names.keys.sort.each do |h|
    hash_to_names[h].each do |name|
      csv << [h, name]
    end
  end
end

puts "Wrote CSV rainbow table to #{CSV_OUT}"

# --- WRITE JSON ({hash: [names...]}) -------------------------------

json_hash = hash_to_names.transform_keys(&:to_s)
File.write(JSON_OUT, JSON.pretty_generate(json_hash))

puts "Wrote JSON rainbow table to #{JSON_OUT}"

# --- OPTIONAL: interactive query -----------------------------------

if ARGV.first == "query"
  target = Integer(ARGV[1] || raise("Usage: #{File.basename($0)} query <hash>"))
  names = hash_to_names[target]
  if names.empty?
    puts "No names for hash #{target}"
  else
    puts "Names for hash #{target}:"
    names.each { |n| puts "  - #{n}" }
  end
else
  puts "Run again with: #{File.basename($0)} query <hash>  # to inspect a specific hash"
end
