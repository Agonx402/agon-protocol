#!/bin/bash

# A script to convert a Phantom private key from a .env file to a Solana CLI-compatible JSON array
# and update the Anchor.toml configuration to use it.
# Run this from inside the agon-protocol directory.

bootstrap_tooling_path() {
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

    if [ -f "$HOME/.cargo/env" ]; then
        # shellcheck disable=SC1090
        source "$HOME/.cargo/env"
    fi

    if ! command -v node >/dev/null 2>&1; then
        LATEST_NODE=$(find "$HOME/.nvm/versions/node" -maxdepth 3 -type f -name node 2>/dev/null | sort -V | tail -1 || true)
        if [ -n "$LATEST_NODE" ]; then
            export PATH="$(dirname "$LATEST_NODE"):$PATH"
        fi
    fi
}

bootstrap_tooling_path

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NETWORK=${1:-devnet}
ENV_FILE="$REPO_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found in the current directory."
    exit 1
fi

# Source the .env file
source $ENV_FILE

if [ "$NETWORK" == "devnet" ]; then
    PRIVATE_KEY=$DEVNET_PRIVATE_KEY
elif [ "$NETWORK" == "mainnet" ]; then
    PRIVATE_KEY=$MAINNET_PRIVATE_KEY
else
    echo "Unsupported network: $NETWORK. Use 'devnet' or 'mainnet'."
    exit 1
fi

if [ -z "$PRIVATE_KEY" ]; then
    echo "Error: No private key found for $NETWORK in $ENV_FILE."
    echo "Please add it: e.g. DEVNET_PRIVATE_KEY=your_base58_string"
    exit 1
fi

OUT_FILE="$REPO_ROOT/keys/$NETWORK-deployer.json"

echo "Setting up $NETWORK deployer wallet..."

# Use Node.js to convert base58 to a JSON byte array
node -e "
try {
    const bs58 = require('bs58');
    const decoded = bs58.decode('$PRIVATE_KEY');
    console.log(JSON.stringify(Array.from(decoded)));
} catch (e) {
    console.error('Failed to decode:', e);
    process.exit(1);
}
" > $OUT_FILE

if [ $? -eq 0 ]; then
    echo "Successfully converted and saved to $OUT_FILE"
    chmod 600 $OUT_FILE
    
    # Update Anchor.toml to point to this new wallet and cluster
    ANCHOR_TOML="$REPO_ROOT/Anchor.toml"
    
    # We use sed to update the cluster and wallet in the [provider] section
    sed -i "s|cluster = \".*\"|cluster = \"$NETWORK\"|" $ANCHOR_TOML
    sed -i "s|wallet = \".*\"|wallet = \"$OUT_FILE\"|" $ANCHOR_TOML
    
    echo "✅ Updated Anchor.toml:"
    echo "  cluster = \"$NETWORK\""
    echo "  wallet = \"$OUT_FILE\""
    echo ""
    echo "You are now ready to run 'anchor deploy' to $NETWORK!"
else
    echo "❌ Error converting private key."
fi
