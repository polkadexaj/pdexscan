#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "========================================"
echo " Starting Polkadex Explorer Deployment"
echo "========================================"

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "Cannot detect OS. /etc/os-release not found."
    exit 1
fi

echo "--> Detected OS: $OS"

# 1. Update system packages and install prerequisites
echo "--> Updating system packages..."
if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
    sudo apt-get update -y
    sudo apt-get install -y apt-transport-https ca-certificates curl software-properties-common git
elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
    sudo yum update -y
    sudo yum install -y yum-utils git
else
    echo "Unsupported OS: $OS. Please install Docker and Git manually."
    exit 1
fi

# 2. Install Docker if not installed
if ! command -v docker &> /dev/null
then
    echo "--> Docker not found. Installing Docker..."
    if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
        curl -fsSL https://download.docker.com/linux/$OS/gpg | sudo apt-key add -
        sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/$OS $(lsb_release -cs) stable" -y
        sudo apt-get update -y
        sudo apt-get install -y docker-ce docker-ce-cli containerd.io
    elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ] || [ "$OS" = "almalinux" ] || [ "$OS" = "rocky" ]; then
        sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        sudo yum install -y docker-ce docker-ce-cli containerd.io
    fi
    
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

# 4.5 Ensure .env exists
if [ ! -f .env ]; then
    echo "--> .env file not found. Copying from .env.example..."
    cp .env.example .env
    echo "PLEASE EDIT .env file with your actual domain and email if different, then re-run deploy.sh."
fi

# 5. Build and deploy Docker containers
echo "--> Initializing Let's Encrypt certificates..."
chmod +x init-letsencrypt.sh
./init-letsencrypt.sh

echo "--> Building and starting full Docker stack..."
sudo docker-compose down || true
sudo docker-compose up -d --build

# 6. Cleanup unused docker images
echo "--> Cleaning up dangling images to save space..."
sudo docker image prune -f

echo "========================================"
echo " Deployment Complete!"
echo "========================================"
echo "The application is now running securely on HTTPS!"
echo "You can check the backend logs using:"
echo "  sudo docker logs pdexplorer-backend -f"
