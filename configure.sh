#!/bin/bash
# Copyright (C) 2025 l5yth
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
    
    if grep -q "^$key=" .env; then
        # Update existing value
        sed -i.bak "s/^$key=.*/$key=$value/" .env
    else
        # Add new value
        echo "$key=$value" >> .env
    fi
}

# Get current values from .env if they exist
SITE_NAME=$(grep "^SITE_NAME=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "My Meshtastic Network")
DEFAULT_CHANNEL=$(grep "^DEFAULT_CHANNEL=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "#MediumFast")
DEFAULT_FREQUENCY=$(grep "^DEFAULT_FREQUENCY=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "868MHz")
MAP_CENTER_LAT=$(grep "^MAP_CENTER_LAT=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "52.502889")
MAP_CENTER_LON=$(grep "^MAP_CENTER_LON=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "13.404194")
MAX_NODE_DISTANCE_KM=$(grep "^MAX_NODE_DISTANCE_KM=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "50")
MATRIX_ROOM=$(grep "^MATRIX_ROOM=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
API_TOKEN=$(grep "^API_TOKEN=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
POTATOMESH_IMAGE_ARCH=$(grep "^POTATOMESH_IMAGE_ARCH=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "linux-amd64")

echo "📍 Location Settings"
echo "-------------------"
read_with_default "Site Name (your mesh network name)" "$SITE_NAME" SITE_NAME
read_with_default "Map Center Latitude" "$MAP_CENTER_LAT" MAP_CENTER_LAT
read_with_default "Map Center Longitude" "$MAP_CENTER_LON" MAP_CENTER_LON
read_with_default "Max Node Distance (km)" "$MAX_NODE_DISTANCE_KM" MAX_NODE_DISTANCE_KM

echo ""
echo "📡 Meshtastic Settings"
echo "---------------------"
read_with_default "Default Channel" "$DEFAULT_CHANNEL" DEFAULT_CHANNEL
read_with_default "Default Frequency (868MHz, 915MHz, etc.)" "$DEFAULT_FREQUENCY" DEFAULT_FREQUENCY

echo ""
echo "💬 Optional Settings"
echo "-------------------"
read_with_default "Matrix Room (optional, e.g., #meshtastic-berlin:matrix.org)" "$MATRIX_ROOM" MATRIX_ROOM

echo ""
echo "🛠 Docker Settings"
echo "------------------"
echo "Specify the Docker image architecture for your host (linux-amd64, linux-arm64, linux-armv7)."
read_with_default "Docker image architecture" "$POTATOMESH_IMAGE_ARCH" POTATOMESH_IMAGE_ARCH

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

# Update .env file
update_env "SITE_NAME" "\"$SITE_NAME\""
update_env "DEFAULT_CHANNEL" "\"$DEFAULT_CHANNEL\""
update_env "DEFAULT_FREQUENCY" "\"$DEFAULT_FREQUENCY\""
update_env "MAP_CENTER_LAT" "$MAP_CENTER_LAT"
update_env "MAP_CENTER_LON" "$MAP_CENTER_LON"
update_env "MAX_NODE_DISTANCE_KM" "$MAX_NODE_DISTANCE_KM"
update_env "MATRIX_ROOM" "\"$MATRIX_ROOM\""
update_env "API_TOKEN" "$API_TOKEN"
update_env "POTATOMESH_IMAGE_ARCH" "$POTATOMESH_IMAGE_ARCH"

# Add other common settings if they don't exist
if ! grep -q "^MESH_SERIAL=" .env; then
    echo "MESH_SERIAL=/dev/ttyACM0" >> .env
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
echo "   Map Center: $MAP_CENTER_LAT, $MAP_CENTER_LON"
echo "   Max Distance: ${MAX_NODE_DISTANCE_KM}km"
echo "   Channel: $DEFAULT_CHANNEL"
echo "   Frequency: $DEFAULT_FREQUENCY"
echo "   Matrix Room: ${MATRIX_ROOM:-'Not set'}"
echo "   API Token: ${API_TOKEN:0:8}..."
echo "   Docker Image Arch: $POTATOMESH_IMAGE_ARCH"
echo ""
echo "🚀 You can now start PotatoMesh with:"
echo "   docker-compose up -d"
echo ""
echo "📖 For more configuration options, see the README.md"
