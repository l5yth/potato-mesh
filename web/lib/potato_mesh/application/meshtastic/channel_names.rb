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

module PotatoMesh
  module App
    module Meshtastic
      # Canonical list of candidate channel names used to build rainbow tables.
      module ChannelNames
        CHANNEL_NAME_CANDIDATES = %w[
          911 Admin ADMIN admin Alert Alpha AlphaNet Alpine Amateur Amazon Anaconda Aquila Arctic Ash Asteroid Astro Aurora Avalanche Backup Basalt Base Base1 Base2 BaseAlpha BaseBravo BaseCharlie Bavaria Beacon Bear BearNet Beat Berg Berlin BerlinMesh BerlinNet Beta BetaBerlin Bison Blackout Blizzard Bolt Bonfire Border Borealis Bravo BravoNet Breeze Bridge Bronze Burner Burrow Callisto Callsign Camp Campfire CampNet Caravan Carbon Carpet Central Chameleon Charlie Chat Checkpoint Checkpoint1 Checkpoint2 Cheetah City Clinic Cloud Cobra Collective Cologne Colony Comet Command Command1 Command2 CommandRoom Comms Comms1 Comms2 CommsNet Commune Control Control1 Control2 ControlRoom Convoy Copper Core Corvus Cosmos Courier Courier1 Courier2 CourierMesh CourierNet CQ CQ1 CQ2 Crow CrowNet DarkNet Dawn Daybreak Daylight Delta DeltaNet Demo DEMO DemoBerlin Den Desert Diamond Distress District Doctor Dortmund Downlink Downlink1 Draco Dragon DragonNet Dune Dusk Eagle EagleNet East EastStar Echo EchoMesh EchoNet Emergency emergency EMERGENCY EmergencyBerlin Epsilon Equinox Europa Falcon Field FieldNet Fire Fire1 Fire2 Firebird Firefly Fireline Fireteam Firewatch Flash Flock Fluss Fog Forest Fox FoxNet Foxtrot FoxtrotMesh FoxtrotNet Frankfurt Freedom Freq Freq1 Freq2 Friedrichshain Frontier Frost Galaxy Gale Gamma Ganymede Gecko General Ghost GhostNet Glacier Gold Granite Grassland Grid Grid1 Grid2 GridNet GridNorth GridSouth Griffin Group Ham HAM Hamburg HAMNet Harbor Harmony HarmonyNet Hawk HawkNet Haze Help Hessen Highway Hilltop Hinterland Hive Hospital HQ HQ1 HQ2 Hub Hub1 Hub2 Hydra Ice Io Iron Jaguar Jungle Jupiter Kiez Kilo KiloMesh KiloNet Kraken Kreuzberg Lava Layer Layer1 Layer2 Layer3 Leipzig Leopard Liberty LightNet Lightning Lima Link Lion Lizard LongFast LongSlow LoRa LoRaBerlin LoRaHessen LoRaMesh LoRaNet LoRaTest Main Mars Med Med1 Med2 Medic MediumFast MediumSlow Mercury Mesh Mesh1 Mesh2 Mesh3 Mesh4 Mesh5 MeshBerlin MeshCollective MeshCologne MeshFrankfurt MeshGrid MeshHamburg MeshHessen MeshLeipzig MeshMunich MeshNet MeshNetwork MeshRuhr Meshtastic MeshTest Meteor Metro Midnight Mirage Mist MoonNet Munich Müggelberg Nebula Nest Network Neukölln Nexus Nightfall NightMesh NightNet Nightshift NightshiftNet Nightwatch Node1 Node2 Node3 Node4 Node5 Nomad NomadMesh NomadNet Nomads Nord North NorthStar Oasis Obsidian Omega Operations OPERATIONS Ops Ops1 Ops2 OpsCenter OpsRoom Orbit Ost Outpost Outsider Owl Pack Packet PacketNet PacketRadio Panther Paramedic Path Peak Phantom Phoenix PhoenixNet Platinum Pluto Polar Prairie Prenzlauer PRIVATE Private Public Pulse PulseNet Python Quasar Radio Radio1 Radio2 RadioNet Rain Ranger Raven RavenNet Relay Relay1 Relay2 Repeater Repeater1 Repeater2 RepeaterHub Rescue Rescue1 Rescue2 RescueTeam Rhythm Ridge River Road Rock Router Router1 Router2 Rover Ruhr Runner Runners Safari Safe Safety Sahara Saturn Savanna Saxony Scout Sector Secure Sensor SENSOR Sensors SENSORS Shade Shadow ShadowNet Shelter Shelter1 Shelter2 ShortFast Sideband Sideband1 Sierra Signal Signal1 Signal2 SignalFire Signals Silver Smoke Snake Snow Solstice SOS Sos SOSBerlin South SouthStar Spectrum Squad StarNet Steel Stone Storm Storm1 Storm2 Stratum Stuttgart Summit SunNet Sunrise Sunset Sync SyncNet Syndicate Süd Tal Tango TangoMesh TangoNet Team Tempo Test TEST test TestBerlin Teufelsberg Thunder Tiger Titan Town Trail Tundra Tunnel Union Unit Universe Uplink Uplink1 Valley Venus Victor Village Viper Volcano Wald Wander Wanderer Wanderers Watch Watch1 Watch2 WaWi West WestStar Whisper Wind Wolf WolfDen WolfMesh WolfNet Wolfpack Wolves Woods Wyvern Zeta Zone Zone1 Zone2 Zone3 Zulu ZuluMesh ZuluNet
        ].freeze
      end
    end
  end
end
