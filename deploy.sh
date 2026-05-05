#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "========================================"
echo " Starting Polkadex Explorer Deployment"
echo "========================================"

# 1. Update system packages
echo "--> Updating system packages..."
sudo apt-get update -y

# 2. Install Docker if not installed
if ! command -v docker &> /dev/null
then
    echo "--> Docker not found. Installing Docker..."
    sudo apt-get install -y apt-transport-https ca-certificates curl software-properties-common git
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
    sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" -y
    sudo apt-get update -y
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io
    sudo systemctl enable docker
    sudo systemctl start docker
    # Add current user to docker group (requires logout/login to take effect for non-sudo)
    sudo usermod -aG docker $USER
    echo "--> Docker installed successfully."
else
    echo "--> Docker is already installed."
fi

# 3. Install Docker Compose if not installed
if ! command -v docker-compose &> /dev/null
then
    echo "--> Docker Compose not found. Installing Docker Compose..."
    # Downloading a stable release of Docker Compose
    sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    echo "--> Docker Compose installed successfully."
else
    echo "--> Docker Compose is already installed."
fi

# 4. Clone or Pull repository
REPO_URL="https://github.com/polkadexaj/pdexscan.git"
REPO_DIR="pdexscan"

if [ -d "$REPO_DIR" ]; then
    echo "--> Repository exists. Pulling latest changes..."
    cd $REPO_DIR
    git pull origin main
else
    echo "--> Cloning repository..."
    git clone $REPO_URL $REPO_DIR
    cd $REPO_DIR
fi

# 5. Build and deploy Docker containers
echo "--> Building and starting Docker containers..."
sudo docker-compose down || true
sudo docker-compose up -d --build

# 6. Cleanup unused docker images
echo "--> Cleaning up dangling images to save space..."
sudo docker image prune -f

echo "========================================"
echo " Deployment Complete!"
echo "========================================"
echo "The application is now running."
echo "Frontend is accessible on port 80."
echo "You can check the backend logs using:"
echo "  sudo docker logs pdexplorer-backend -f"
