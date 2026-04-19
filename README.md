# Redline Monitor

Compact Linux monitoring and control plugin for OpenDeck.

![Redline Monitor Dashboard](assets/screenshot.png)

## Highlights

* AMD, Intel, and NVIDIA support
* Multi GPU selector for GPU and VRAM
* Generic Fan Speed action with selector and custom name
* Stable battery device selector
* sysfs first battery handling for better Linux reliability
* Key and encoder actions
* Optional custom on press command on every action
* Compact monitoring cards with action specific settings

## Included

Monitoring:
CPU, GPU, VRAM, RAM, Network, Disk, Ping, Top Proc, Time and Date, Fan Speed, Battery

Controls:
Audio Volume, Alarm Timer, Monitor Brightness

## What each action shows

* **CPU** shows load, temperature, and CPU power. The bar represents temperature with a 100°C cap.
* **GPU** shows usage, power, and temperature. The bar represents temperature with a 100°C cap.
* **VRAM** shows used and total VRAM for the selected GPU.
* **RAM** shows used and total system memory.
* **Network** shows download and upload throughput.
* **Disk** shows combined usage and free space.
* **Ping** shows latency to a custom host. The bar is capped at 100 ms.
* **Top Proc** shows the top CPU consumer.
* **Time and Date** works on keys and encoders.
* **Fan Speed** shows the selected fan speed with generic hwmon detection, AMD GPU fan support, NVIDIA fan support where available, and an optional custom display name.
* **Battery** shows the selected battery device, percentage, and charging state.
* **Audio Volume** supports key and encoder control.
* **Alarm Timer** is encoder based.
* **Monitor Brightness** is encoder based through DDC or CI.

## Settings

Only relevant settings are shown for the selected action.

Available settings include:

* Ping host
* Network interface override
* GPU selector
* Battery device selector
* Fan selector
* Custom fan name
* Volume step
* Brightness step
* Timer step
* Top mode
* Refresh rate
* On press action
* Custom command

## Requirements

Depending on the action, you may need:

* `wireplumber`
* `ddcutil`
* `lm-sensors`
* `zenergy`
* `nvidia-smi`
* `pciutils`

If Ryzen CPU power reads as `0W`, install `zenergy`.

Arch Linux:

```sh
yay -S zenergy-dkms-git
```

For monitor brightness through DDC or CI, add your user to the `i2c` group:

```sh
sudo usermod -aG i2c $USER
```

## Notes

Battery handling prefers sysfs when available and falls back to UPower when needed. This improves reliability for wireless Linux devices that expose unstable or duplicated battery nodes.

Fan detection is designed to stay generic. Standard hwmon fans are detected first, AMD GPU fans are supported through hwmon, and NVIDIA fan reporting is used when `nvidia-smi` is available.

Custom press commands are useful for launching tools, restarting services, or triggering recovery actions directly from the same key.
