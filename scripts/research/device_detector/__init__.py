"""Research code for Step C4 part 3: devices in an X-ray frame.

A small network marks the pixels of catheters and guidewires in one frame.
It is trained on the WEISS catheter segmentation set (UCL, CC BY 4.0), with
synthetic contrast-filled vessels added so that a vessel is not taken for a
device. Not imported by the planner. Every output goes to external storage
(``pose_initializer/storage.py``). See docs/research/device-network-v1.md.
"""
