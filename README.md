# Redline Monitor

A high performance System Information dashboard for Stream Deck on Linux. Features real time CPU and GPU monitoring for AMD, Intel, and NVIDIA systems, intelligent disk aggregation, encoder based system controls, and optional custom on press commands.

![Redline Monitor Dashboard](assets/screenshot.png)

## Features

Redline Monitor includes actions for:

* CPU
* GPU
* VRAM
* RAM
* Network
* Disk
* Ping
* Top Proc
* Time and Date
* Audio Volume
* Alarm Timer
* Monitor Brightness

Additional highlights:

* Linux focused with support for AMD, Intel, and NVIDIA hardware
* Compact monitoring cards for keys and encoders
* Per button and per encoder press custom command support
* Intelligent disk aggregation
* Configurable refresh rate
* Custom ping target
* Optional network interface override

## Action details

* **CPU** shows load, temperature, and CPU power. Existing AMD behavior is preserved, and Intel package power is supported through Intel RAPL. Press opens Plasma System Monitor by default, or runs your custom command.
* **GPU** shows usage, power, and temperature. Existing AMD behavior is preserved, and NVIDIA GPUs are supported through `nvidia-smi`. Press opens LACT by default, or runs your custom command.
* **VRAM** shows used and total GPU memory.
* **RAM** shows active memory usage.
* **Network** shows download and upload throughput.
* **Disk** shows combined disk usage and free space.
* **Ping** shows latency to a custom host. Press forces an immediate refresh by default, or runs your custom command.
* **Top Proc** shows the current top CPU consumer.
* **Time and Date** shows local time and date.
* **Audio Volume** is available as key and encoder action. Press toggles mute by default, or runs your custom command.
* **Alarm Timer** is available as encoder action. Press controls timer state by default, or runs your custom command.
* **Monitor Brightness** is available as encoder action through DDC or CI. Press resets brightness by default, or runs your custom command.

## Settings

The property inspector supports these settings:

* **Ping host** for the Ping action
* **Network interface override** for the Network action
* **Volume step** for Audio Volume
* **Brightness step** for Monitor Brightness
* **Timer step in minutes** for Alarm Timer
* **Top process mode** with grouped or raw process view
* **Refresh rate** as plugin wide polling interval
* **On press** to choose between the default action and a custom command
* **Command** for your custom shell command

Custom press settings are stored per button or per encoder press context.

## Requirements

Depending on the action you use, these tools may be needed:

* `wireplumber` for audio volume control
* `ddcutil` for monitor brightness control
* `lm-sensors` for temperature readings
* `zenergy` for AMD Ryzen package power readings
* `nvidia-smi` for NVIDIA GPU metrics

If CPU power reads as `0W` on Ryzen, install `zenergy`.

Arch Linux: `yay -S zenergy-dkms-git`

Intel CPU package power is supported through Intel RAPL when available.

For NVIDIA GPU metrics, make sure `nvidia-smi` is available.

For monitor brightness control through DDC or CI, add your user to the `i2c` group:

`sudo usermod -aG i2c $USER`

## Notes

Custom press commands are useful for restarting helper services, launching tools, or recovering flaky external monitoring software directly from the same key that shows the metric.
