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
SITE_NAME=$(grep "^SITE_NAME=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "PotatoMesh Demo")
CHANNEL=$(grep "^CHANNEL=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "#LongFast")
FREQUENCY=$(grep "^FREQUENCY=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "915MHz")
FEDERATION=$(grep "^FEDERATION=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "1")
PRIVATE=$(grep "^PRIVATE=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "0")
MAP_CENTER=$(grep "^MAP_CENTER=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "38.761944,-27.090833")
MAX_DISTANCE=$(grep "^MAX_DISTANCE=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "42")
CONTACT_LINK=$(grep "^CONTACT_LINK=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "#potatomesh:dod.ngo")
API_TOKEN=$(grep "^API_TOKEN=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")
POTATOMESH_IMAGE_ARCH=$(grep "^POTATOMESH_IMAGE_ARCH=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "linux-amd64")
POTATOMESH_IMAGE_TAG=$(grep "^POTATOMESH_IMAGE_TAG=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "latest")
INSTANCE_DOMAIN=$(grep "^INSTANCE_DOMAIN=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || echo "")

echo "📍 Location Settings"
echo "-------------------"
read_with_default "Site Name (your mesh network name)" "$SITE_NAME" SITE_NAME
read_with_default "Map Center (lat,lon)" "$MAP_CENTER" MAP_CENTER
read_with_default "Max Distance (km)" "$MAX_DISTANCE" MAX_DISTANCE

echo ""
echo "📡 Meshtastic Settings"
echo "---------------------"
read_with_default "Channel" "$CHANNEL" CHANNEL
read_with_default "Frequency (868MHz, 915MHz, etc.)" "$FREQUENCY" FREQUENCY

echo ""
echo "💬 Optional Settings"
echo "-------------------"
read_with_default "Chat link or Matrix room (optional)" "$CONTACT_LINK" CONTACT_LINK

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

echo ""
echo "🛠 Docker Settings"
echo "------------------"
echo "Specify the Docker image architecture for your host (linux-amd64, linux-arm64, linux-armv7)."
read_with_default "Docker image architecture" "$POTATOMESH_IMAGE_ARCH" POTATOMESH_IMAGE_ARCH
echo "Enter the Docker image tag to deploy (use 'latest' for the newest release or pin a version such as v3.0)."
read_with_default "Docker image tag (latest, vX.Y, etc.)" "$POTATOMESH_IMAGE_TAG" POTATOMESH_IMAGE_TAG

echo ""
echo "🌐 Domain Settings"
echo "------------------"
echo "Provide the public hostname that clients should use to reach this PotatoMesh instance."
echo "Leave blank to allow automatic detection via reverse DNS."
read_with_default "Instance domain (e.g. mesh.example.org)" "$INSTANCE_DOMAIN" INSTANCE_DOMAIN

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
update_env "CHANNEL" "\"$CHANNEL\""
update_env "FREQUENCY" "\"$FREQUENCY\""
update_env "MAP_CENTER" "\"$MAP_CENTER\""
update_env "MAX_DISTANCE" "$MAX_DISTANCE"
update_env "CONTACT_LINK" "\"$CONTACT_LINK\""
update_env "API_TOKEN" "$API_TOKEN"
update_env "POTATOMESH_IMAGE_ARCH" "$POTATOMESH_IMAGE_ARCH"
update_env "POTATOMESH_IMAGE_TAG" "$POTATOMESH_IMAGE_TAG"
update_env "FEDERATION" "$FEDERATION"
update_env "PRIVATE" "$PRIVATE"
if [ -n "$INSTANCE_DOMAIN" ]; then
    update_env "INSTANCE_DOMAIN" "$INSTANCE_DOMAIN"
else
    sed -i.bak '/^INSTANCE_DOMAIN=.*/d' .env
fi

# Migrate legacy connection settings and ensure defaults exist
if grep -q "^MESH_SERIAL=" .env; then
    legacy_connection=$(grep "^MESH_SERIAL=" .env | head -n1 | cut -d'=' -f2-)
    if [ -n "$legacy_connection" ] && ! grep -q "^CONNECTION=" .env; then
        echo "♻️  Migrating legacy MESH_SERIAL value to CONNECTION"
        update_env "CONNECTION" "$legacy_connection"
    fi
    sed -i.bak '/^MESH_SERIAL=.*/d' .env
fi

if ! grep -q "^CONNECTION=" .env; then
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
echo "   Max Distance: ${MAX_DISTANCE}km"
echo "   Channel: $CHANNEL"
echo "   Frequency: $FREQUENCY"
echo "   Chat: ${CONTACT_LINK:-'Not set'}"
echo "   API Token: ${API_TOKEN:0:8}..."
echo "   Docker Image Arch: $POTATOMESH_IMAGE_ARCH"
echo "   Docker Image Tag: $POTATOMESH_IMAGE_TAG"
echo "   Private Mode: ${PRIVATE}"
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
