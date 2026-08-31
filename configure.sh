#!/bin/bash
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

# PotatoMesh Configuration Script
# This script helps you configure your PotatoMesh instance with your local settings

set -e

echo "🥔 PotatoMesh Configuration"
echo "=========================="
echo ""

# Check if .env exists, if not create from .env.example
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo "📋 Creating .env file from .env.example..."
        cp .env.example .env
    else
        echo "📋 Creating new .env file..."
        touch .env
    fi
fi

echo "🔧 Let's configure your PotatoMesh instance!"
echo ""

# Function to read input with default
read_with_default() {
    local prompt="$1"
    local default="$2"
    local var_name="$3"

    if [ -n "$default" ]; then
        read -p "$prompt [$default]: " input
        input=${input:-$default}
    else
        read -p "$prompt: " input
    fi

    eval "$var_name='$input'"
}

# Function to update .env file
update_env() {
    local key="$1"
    local value="$2"
    local escaped_value

    # Escape characters that would break the sed replacement delimiter or introduce backreferences
    escaped_value=$(printf '%s' "$value" | sed -e 's/[&|]/\\&/g')

    if grep -q "^$key=" .env; then
        # Update existing value
        sed -i.bak "s|^$key=.*|$key=$escaped_value|" .env
    else
        # Add new value
        echo "$key=$value" >> .env
    fi
}

# Get current values from .env if they exist
SITE_NAME=$(grep "^SITE_NAME=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "PotatoMesh Demo")
# Radio preset/frequency: prefer the canonical MESHTASTIC_* names, falling back
# to the deprecated CHANNEL/FREQUENCY aliases so existing .env files still load.
MESHTASTIC_PRESET=$(grep "^MESHTASTIC_PRESET=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
[ -n "$MESHTASTIC_PRESET" ] || MESHTASTIC_PRESET=$(grep "^CHANNEL=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "#LongFast")
MESHTASTIC_FREQ=$(grep "^MESHTASTIC_FREQ=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
[ -n "$MESHTASTIC_FREQ" ] || MESHTASTIC_FREQ=$(grep "^FREQUENCY=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "915MHz")
MESHCORE_PRESET=$(grep "^MESHCORE_PRESET=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
MESHCORE_FREQ=$(grep "^MESHCORE_FREQ=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
PROTOCOL=$(grep "^PROTOCOL=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "meshtastic")
TX_ENABLED=$(grep "^TX_ENABLED=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "0")
TX_ANNOUNCE=$(grep "^TX_ANNOUNCE=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "0")
RETICULUM_CONFIG_DIR=$(grep "^RETICULUM_CONFIG_DIR=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
RETICULUM_INTERFACES=$(grep "^RETICULUM_INTERFACES=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
RETICULUM_FREQ=$(grep "^RETICULUM_FREQ=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
RETICULUM_PRESET=$(grep "^RETICULUM_PRESET=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
FEDERATION=$(grep "^FEDERATION=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "1")
PRIVATE=$(grep "^PRIVATE=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "0")
HIDDEN_CHANNELS=$(grep "^HIDDEN_CHANNELS=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
ALLOWED_CHANNELS=$(grep "^ALLOWED_CHANNELS=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
MAP_CENTER=$(grep "^MAP_CENTER=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "38.761944,-27.090833")
MAP_ZOOM=$(grep "^MAP_ZOOM=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
MAX_DISTANCE=$(grep "^MAX_DISTANCE=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "42")
CONTACT_LINK=$(grep "^CONTACT_LINK=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "#potatomesh:dod.ngo")
API_TOKEN=$(grep "^API_TOKEN=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
POTATOMESH_IMAGE_ARCH=$(grep "^POTATOMESH_IMAGE_ARCH=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "linux-amd64")
POTATOMESH_IMAGE_TAG=$(grep "^POTATOMESH_IMAGE_TAG=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "latest")
INSTANCE_DOMAIN=$(grep "^INSTANCE_DOMAIN=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
DEBUG=$(grep "^DEBUG=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "0")
CONNECTION=$(grep "^CONNECTION=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "/dev/ttyACM0")

echo ""
echo "🌐 Domain Settings"
echo "------------------"
echo "Provide the public hostname that clients should use to reach this PotatoMesh instance."
echo "Leave blank to allow automatic detection via reverse DNS."
read_with_default "Instance domain (e.g. mesh.example.org)" "$INSTANCE_DOMAIN" INSTANCE_DOMAIN

echo "📍 Location Settings"
echo "-------------------"
read_with_default "Site Name (your mesh network name)" "$SITE_NAME" SITE_NAME
read_with_default "Map Center (lat,lon)" "$MAP_CENTER" MAP_CENTER
read_with_default "Default map zoom (leave blank to auto-fit)" "$MAP_ZOOM" MAP_ZOOM
read_with_default "Max Distance (km)" "$MAX_DISTANCE" MAX_DISTANCE

echo ""
echo "🛰  Protocol"
echo "-----------"
echo "Which mesh protocol should the ingestor read? (meshtastic, meshcore, reticulum)"
read_with_default "Protocol" "$PROTOCOL" PROTOCOL

echo ""
echo "📡 Radio Settings"
echo "-----------------"
echo "Preset and frequency are display values for the join strip and federation directory."
case "$PROTOCOL" in
    meshcore)
        read_with_default "Meshcore preset" "$MESHCORE_PRESET" MESHCORE_PRESET
        read_with_default "Meshcore frequency (868MHz, 915MHz, etc.)" "$MESHCORE_FREQ" MESHCORE_FREQ
        ;;
    reticulum)
        echo "Reticulum announces carry no radio metadata; skipping preset/frequency."
        ;;
    *)
        read_with_default "Meshtastic preset" "$MESHTASTIC_PRESET" MESHTASTIC_PRESET
        read_with_default "Meshtastic frequency (868MHz, 915MHz, etc.)" "$MESHTASTIC_FREQ" MESHTASTIC_FREQ
        ;;
esac

echo ""
echo "💬 Optional Settings"
echo "-------------------"
read_with_default "Chat link or Matrix room (optional)" "$CONTACT_LINK" CONTACT_LINK
read_with_default "Debug logging (1=enabled, 0=disabled)" "$DEBUG" DEBUG

echo ""
echo "🤝 Federation Settings"
echo "----------------------"
echo "Federation shares instance metadata with other PotatoMesh deployments."
echo "Set to 1 to enable discovery or 0 to keep your instance isolated."
read_with_default "Enable federation (1=yes, 0=no)" "$FEDERATION" FEDERATION

echo ""
echo "🙈 Privacy Settings"
echo "-------------------"
echo "Private mode hides public mesh messages from unauthenticated visitors."
echo "Set to 1 to hide public feeds or 0 to keep them visible."
read_with_default "Enable private mode (1=yes, 0=no)" "$PRIVATE" PRIVATE
echo "Provide a comma-separated whitelist of channel names to ingest (optional)."
echo "When set, only listed channels are ingested unless explicitly hidden below."
read_with_default "Allowed channels" "$ALLOWED_CHANNELS" ALLOWED_CHANNELS
echo "Provide a comma-separated list of channel names to hide from the web UI (optional)."
read_with_default "Hidden channels" "$HIDDEN_CHANNELS" HIDDEN_CHANNELS

echo ""
echo "🛠 Docker Settings"
echo "------------------"
echo "Specify the Docker image architecture for your host (linux-amd64, linux-arm64, linux-armv7)."
read_with_default "Docker image architecture" "$POTATOMESH_IMAGE_ARCH" POTATOMESH_IMAGE_ARCH
echo "Enter the Docker image tag to deploy (use 'latest' for the newest release or pin a version such as v3.0)."
read_with_default "Docker image tag (latest, vX.Y, etc.)" "$POTATOMESH_IMAGE_TAG" POTATOMESH_IMAGE_TAG

echo ""
echo "🔌 Ingestor Connection"
echo "----------------------"
if [ "$PROTOCOL" = "reticulum" ]; then
    echo "Reticulum uses an RNS config directory, not a single endpoint."
    echo "Leave the directory blank to use ~/.reticulum. Point it at the same"
    echo "directory your rnsd uses so interface filtering can resolve names."
    read_with_default "RNS config directory (blank = ~/.reticulum)" "$RETICULUM_CONFIG_DIR" RETICULUM_CONFIG_DIR
    echo "Restrict ingestion to named interfaces (case-insensitive substring)."
    echo "Leave blank to ingest announces from every interface."
    read_with_default "Reticulum interfaces" "$RETICULUM_INTERFACES" RETICULUM_INTERFACES
    echo "Frequency and preset are read from your RNS config; leave blank unless"
    echo "you want to override what the dashboard displays."
    read_with_default "Reticulum frequency (blank = from RNS config)" "$RETICULUM_FREQ" RETICULUM_FREQ
    read_with_default "Reticulum preset (blank = from RNS config)" "$RETICULUM_PRESET" RETICULUM_PRESET
else
    echo "Define how the mesh ingestor connects to your device."
    echo "Use serial devices like /dev/ttyACM0, TCP endpoints such as tcp://host:port,"
    echo "or Bluetooth addresses when supported."
    read_with_default "Connection target" "$CONNECTION" CONNECTION
fi

echo ""
echo "📻 Transmit Settings"
echo "--------------------"
echo "The ingestor listens only by default. Enabling transmit puts traffic on"
echo "shared airtime; announcements additionally broadcast one activity line per day."
read_with_default "Allow transmitting (1=yes, 0=no)" "$TX_ENABLED" TX_ENABLED
if [ "$TX_ENABLED" = "1" ]; then
    read_with_default "Send daily activity announcement (1=yes, 0=no)" "$TX_ANNOUNCE" TX_ANNOUNCE
else
    TX_ANNOUNCE=0
fi

echo ""
echo "🔐 Security Settings"
echo "-------------------"
echo "The API token is used for secure communication between the web app and ingestor."
echo "You can provide your own custom token or let us generate a secure one for you."
echo ""

if [ -z "$API_TOKEN" ]; then
    echo "No existing API token found. Generating a secure token..."
    API_TOKEN=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || echo "your-secure-api-token-here")
    echo "✅ Generated secure API token: ${API_TOKEN:0:8}..."
    echo ""
    read -p "Use this generated token? (Y/n): " use_generated
    if [[ "$use_generated" =~ ^[Nn]$ ]]; then
        read -p "Enter your custom API token: " API_TOKEN
    fi
else
    echo "Existing API token found: ${API_TOKEN:0:8}..."
    read -p "Keep existing token? (Y/n): " keep_existing
    if [[ "$keep_existing" =~ ^[Nn]$ ]]; then
        read -p "Enter new API token (or press Enter to generate): " new_token
        if [ -n "$new_token" ]; then
            API_TOKEN="$new_token"
        else
            echo "Generating new secure token..."
            API_TOKEN=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || echo "your-secure-api-token-here")
            echo "✅ Generated new API token: ${API_TOKEN:0:8}..."
        fi
    fi
fi

echo ""
echo "📝 Updating .env file..."

# Write KEY="VALUE" when the value is non-empty, otherwise strip the key so the
# app falls back to its own default rather than reading an empty override.
update_env_optional() {
    local key="$1"
    local value="$2"
    if [ -n "$value" ]; then
        update_env "$key" "\"$value\""
    else
        sed -i.bak "/^$key=.*/d" .env
    fi
}

# Update .env file
update_env "SITE_NAME" "\"$SITE_NAME\""
update_env "PROTOCOL" "$PROTOCOL"
update_env_optional "MESHTASTIC_PRESET" "$MESHTASTIC_PRESET"
update_env_optional "MESHTASTIC_FREQ" "$MESHTASTIC_FREQ"
update_env_optional "MESHCORE_PRESET" "$MESHCORE_PRESET"
update_env_optional "MESHCORE_FREQ" "$MESHCORE_FREQ"
update_env "TX_ENABLED" "$TX_ENABLED"
update_env "TX_ANNOUNCE" "$TX_ANNOUNCE"
update_env_optional "RETICULUM_CONFIG_DIR" "$RETICULUM_CONFIG_DIR"
update_env_optional "RETICULUM_INTERFACES" "$RETICULUM_INTERFACES"
update_env_optional "RETICULUM_FREQ" "$RETICULUM_FREQ"
update_env_optional "RETICULUM_PRESET" "$RETICULUM_PRESET"
update_env "MAP_CENTER" "\"$MAP_CENTER\""
if [ -n "$MAP_ZOOM" ]; then
    update_env "MAP_ZOOM" "$MAP_ZOOM"
else
    sed -i.bak '/^MAP_ZOOM=.*/d' .env
fi
update_env "MAX_DISTANCE" "$MAX_DISTANCE"
update_env "CONTACT_LINK" "\"$CONTACT_LINK\""
update_env "DEBUG" "$DEBUG"
update_env "API_TOKEN" "$API_TOKEN"
update_env "POTATOMESH_IMAGE_ARCH" "$POTATOMESH_IMAGE_ARCH"
update_env "POTATOMESH_IMAGE_TAG" "$POTATOMESH_IMAGE_TAG"
update_env "FEDERATION" "$FEDERATION"
update_env "PRIVATE" "$PRIVATE"
if [ "$PROTOCOL" = "reticulum" ]; then
    # Reticulum has no single endpoint; drop any inherited serial default so the
    # ingestor does not log an ignored-CONNECTION warning on every start.
    sed -i.bak '/^CONNECTION=.*/d' .env
else
    update_env "CONNECTION" "$CONNECTION"
fi
if [ -n "$ALLOWED_CHANNELS" ]; then
    update_env "ALLOWED_CHANNELS" "\"$ALLOWED_CHANNELS\""
else
    sed -i.bak '/^ALLOWED_CHANNELS=.*/d' .env
fi
if [ -n "$HIDDEN_CHANNELS" ]; then
    update_env "HIDDEN_CHANNELS" "\"$HIDDEN_CHANNELS\""
else
    sed -i.bak '/^HIDDEN_CHANNELS=.*/d' .env
fi
if [ -n "$INSTANCE_DOMAIN" ]; then
    update_env "INSTANCE_DOMAIN" "$INSTANCE_DOMAIN"
else
    sed -i.bak '/^INSTANCE_DOMAIN=.*/d' .env
fi

if [ "$PROTOCOL" != "reticulum" ] && ! grep -q "^CONNECTION=" .env; then
    echo "CONNECTION=/dev/ttyACM0" >> .env
fi

if ! grep -q "^DEBUG=" .env; then
    echo "DEBUG=0" >> .env
fi

# Clean up backup file
rm -f .env.bak

echo ""
echo "✅ Configuration complete!"
echo ""
echo "📋 Your settings:"
echo "   Site Name: $SITE_NAME"
echo "   Map Center: $MAP_CENTER"
if [ -n "$MAP_ZOOM" ]; then
    echo "   Map Zoom: $MAP_ZOOM"
else
    echo "   Map Zoom: Auto-fit"
fi
echo "   Max Distance: ${MAX_DISTANCE}km"
echo "   Protocol: $PROTOCOL"
case "$PROTOCOL" in
    meshcore)
        echo "   Preset: ${MESHCORE_PRESET:-'Not set'}"
        echo "   Frequency: ${MESHCORE_FREQ:-'Not set'}"
        ;;
    reticulum)
        echo "   RNS Config Dir: ${RETICULUM_CONFIG_DIR:-'~/.reticulum'}"
        echo "   Interfaces: ${RETICULUM_INTERFACES:-'All'}"
        echo "   Frequency: ${RETICULUM_FREQ:-'From RNS config'}"
        echo "   Preset: ${RETICULUM_PRESET:-'From RNS config'}"
        ;;
    *)
        echo "   Preset: $MESHTASTIC_PRESET"
        echo "   Frequency: $MESHTASTIC_FREQ"
        ;;
esac
echo "   Transmit: ${TX_ENABLED} (announce: ${TX_ANNOUNCE})"
echo "   Chat: ${CONTACT_LINK:-'Not set'}"
echo "   Debug Logging: ${DEBUG}"
if [ "$PROTOCOL" != "reticulum" ]; then
    echo "   Connection: ${CONNECTION}"
fi
echo "   API Token: ${API_TOKEN:0:8}..."
echo "   Docker Image Arch: $POTATOMESH_IMAGE_ARCH"
echo "   Docker Image Tag: $POTATOMESH_IMAGE_TAG"
echo "   Private Mode: ${PRIVATE}"
echo "   Allowed Channels: ${ALLOWED_CHANNELS:-'All'}"
echo "   Hidden Channels: ${HIDDEN_CHANNELS:-'None'}"
echo "   Instance Domain: ${INSTANCE_DOMAIN:-'Auto-detected'}"
if [ "${FEDERATION:-1}" = "0" ]; then
    echo "   Federation: Disabled"
else
    echo "   Federation: Enabled"
fi
echo ""
echo "🚀 You can now start PotatoMesh with:"
echo "   docker-compose up -d"
echo ""
echo "📖 For more configuration options, see the README.md"
