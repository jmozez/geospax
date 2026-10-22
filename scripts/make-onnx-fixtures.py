#!/usr/bin/env python3
"""Tiny ONNX models with known answers for scripts/test-detect.py (needs `pip install onnx numpy`).

  seg_red.onnx   input [1,3,h,w] (any size), output [1,2,h,w]: class 1 where a pixel is red
                 (logit = R - G - B, background logit = 0.25), class 0 elsewhere
  det_v8.onnx    input [1,3,64,64], YOLOv8 layout [1, 4+2, 8]: fixed boxes in input pixels, two of them
                 near-duplicates (NMS keeps one), one below the score threshold
  det_v5.onnx    input [1,3,64,64], YOLOv5 layout [1, 8, 5+2] (objectness × class score), same boxes
The detection models ignore their input: they test decoding, NMS and georeferencing, not vision.
"""
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

out = sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/onnx"
os.makedirs(out, exist_ok=True)


def save(graph, name, meta=None):
    m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="geospax-fixtures")
    m.ir_version = 8
    for k, v in (meta or {}).items():
        m.metadata_props.add(key=k, value=v)
    onnx.checker.check_model(m)
    onnx.save(m, os.path.join(out, name))
    print("wrote", name)


# segmentation: 1x1 convolution, inputs scaled to 0..1
W = np.zeros((2, 3, 1, 1), np.float32)
W[1, :, 0, 0] = [1.0, -1.0, -1.0]
B = np.array([0.25, 0.0], np.float32)
g = helper.make_graph(
    [helper.make_node("Conv", ["image", "W", "B"], ["logits"])],
    "seg_red",
    [helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 3, "h", "w"])],
    [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 2, "h", "w"])],
    [numpy_helper.from_array(W, "W"), numpy_helper.from_array(B, "B")],
)
save(g, "seg_red.onnx", {"names": "{0: 'background', 1: 'red roof'}"})

# boxes (cx, cy, w, h) in the 64 x 64 input, per class scores
boxes = [
    (16, 16, 8, 8, 0.90, 0.05),   # class 0
    (17, 16, 8, 8, 0.80, 0.05),   # near-duplicate of the first: suppressed
    (48, 40, 10, 6, 0.10, 0.85),  # class 1
    (32, 56, 6, 6, 0.10, 0.12),   # below the threshold
] + [(0, 0, 1, 1, 0.0, 0.0)] * 4
a = np.array(boxes, np.float32)  # [8, 6]


def const_graph(name, arr):
    return helper.make_graph(
        [helper.make_node("Constant", [], ["boxes"], value=numpy_helper.from_array(arr, "c")),
         # depend on the input so the graph is a function of it (ReduceMax(x) * 0 + boxes)
         helper.make_node("ReduceMax", ["image"], ["m"], keepdims=0),
         helper.make_node("Mul", ["m", "zero"], ["z"]),
         helper.make_node("Add", ["boxes", "z"], ["output0"])],
        name,
        [helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 3, 64, 64])],
        [helper.make_tensor_value_info("output0", TensorProto.FLOAT, list(arr.shape))],
        [numpy_helper.from_array(np.array(0, np.float32), "zero")],
    )


save(const_graph("det_v8", a.T[None, :, :].copy()), "det_v8.onnx", {"names": "{0: 'tree', 1: 'house'}"})
v5 = np.concatenate([a[:, :4], np.ones((8, 1), np.float32), a[:, 4:]], axis=1)  # objectness 1
v5[4:, 4] = 0
save(const_graph("det_v5", v5[None, :, :].copy()), "det_v5.onnx", {"names": "{0: 'tree', 1: 'house'}"})
