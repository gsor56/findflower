#!/usr/bin/env python3
"""Bounded smoke test for the remote streaming trainer."""
import os
import runpy
import sys

os.environ["FLORA_TEST_RUN"] = "1"
sys.argv = [sys.argv[0], "--epochs", "2", "--active-classes", "25", "--workers", "0", "--batch-size", "2", "--grad-accum", "1"]
runpy.run_path(os.path.join(os.path.dirname(__file__), "train_flora_ultra.py"), run_name="__main__")
