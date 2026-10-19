"""Zombie forearm for the grave capture animation, rendered as transparent frames.

Run headless:
  blender -b --factory-startup -P scripts/hand/grave_hand.py -- MH_DIR OUT_DIR MODE [args]

MH_DIR holds the MakeHuman 1.x CC0 assets base.obj, default.mhskel and
default_weights.mhw (makehumancommunity/makehuman, makehuman/data). The right
forearm and hand are cut from the base mesh, bound to MakeHuman's own finger
skeleton and weights through a volume-preserving armature, made gaunt, and lit
like a moonlit grave.
"""

import json
import math
import os
import sys

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Quaternion, Vector

ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
MH = os.path.abspath(ARGS[0])
OUT = os.path.abspath(ARGS[1])
MODE = ARGS[2] if len(ARGS) > 2 else "look"
os.makedirs(OUT, exist_ok=True)
V = Vector

ARM_BONES = ["lowerarm01.R", "lowerarm02.R", "wrist.R"]
ARM_BONES += [f"metacarpal{i}.R" for i in range(1, 5)]
ARM_BONES += [f"finger{f}-{s}.R" for f in range(1, 6) for s in range(1, 4)]


# ---------------------------------------------------------------------------
# MakeHuman assets


def read_obj(path):
    vertices, faces, group = [], [], None
    with open(path) as handle:
        for line in handle:
            if line.startswith("v "):
                vertices.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("g "):
                group = line.split()[1]
            elif line.startswith("f ") and group == "body":
                faces.append([int(token.split("/")[0]) - 1 for token in line.split()[1:]])
    return np.array(vertices), faces


def load_arm():
    vertices, faces = read_obj(os.path.join(MH, "base.obj"))
    skeleton = json.load(open(os.path.join(MH, "default.mhskel")))
    weights = json.load(open(os.path.join(MH, "default_weights.mhw")))["weights"]

    def joint(name):
        return vertices[skeleton["joints"][name]].mean(axis=0)

    bones = {}
    for name in ARM_BONES:
        bone = skeleton["bones"][name]
        bones[name] = dict(head=joint(bone["head"]), tail=joint(bone["tail"]),
                           parent=bone["parent"] if bone["parent"] in ARM_BONES else None)
    table = np.zeros((len(vertices), len(ARM_BONES)))
    other = np.zeros(len(vertices))
    for name, pairs in weights.items():
        for index, value in pairs:
            if name in ARM_BONES:
                table[index, ARM_BONES.index(name)] += value
            else:
                other[index] += value
    # Keep faces fully owned by the forearm and hand; the cut end sinks below the page.
    share = table.sum(axis=1) / np.maximum(table.sum(axis=1) + other, 1e-9)
    kept = [face for face in faces if all(share[i] > 0.98 for i in face)]
    used = sorted({i for face in kept for i in face})
    remap = {old: new for new, old in enumerate(used)}
    kept = [[remap[i] for i in face] for face in kept]
    table = table[used]
    table /= table.sum(axis=1, keepdims=True)
    return vertices[used], kept, bones, table


def orientation(bones):
    """Rotate MakeHuman space so the forearm points up and the palm faces -Y."""
    elbow = bones["lowerarm01.R"]["head"]
    wrist = bones["wrist.R"]["head"]
    up = wrist - elbow
    up /= np.linalg.norm(up)
    across = bones["finger2-1.R"]["head"] - bones["finger5-1.R"]["head"]
    palm = np.cross(across, bones["finger3-1.R"]["head"] - wrist)
    palm -= up * palm.dot(up)
    palm /= np.linalg.norm(palm)
    # Right hand: index-to-pinky crossed with wrist-to-fingers points out of the palm or the back.
    side = np.cross(up, palm)
    basis = np.array([side, -palm, up])  # rows: new X, Y, Z
    return basis, wrist


# Phalanx lengthening per segment (proximal, middle, distal) and the waist of
# each bone as a share of its rest girth: long bony fingers with knuckles that
# stand proud, a wasted forearm and a hollowed palm.
STRETCH = {"finger1": (1.0, 1.06, 1.12)} | {f"finger{f}": (1.12, 1.16, 1.24) for f in range(2, 6)}
WAIST = {"finger": 0.76, "metacarpal": 0.86, "wrist": 0.80, "lowerarm02": 0.64, "lowerarm01": 0.78}
KNUCKLE = 1.08


def waist(name):
    return next(value for key, value in WAIST.items() if name.startswith(key))


def gaunt(points, bones, table):
    """Reshape the rest mesh and skeleton: every vertex is re-expressed against
    each bone that owns it (position along the bone, offset from its axis), the
    bone is lengthened and its flesh drawn in towards the axis, and the
    per-bone results are blended by the skin weights."""
    heads = {name: np.array(bone["head"]) for name, bone in bones.items()}
    tails = {name: np.array(bone["tail"]) for name, bone in bones.items()}
    new_heads, new_tails = dict(heads), dict(tails)
    for name in ARM_BONES:  # parents come first in ARM_BONES
        chain, _, segment = name.partition("-")
        stretch = STRETCH.get(chain, (1, 1, 1))[int(segment[0]) - 1] if segment else 1.0
        parent = bones[name]["parent"]
        if name.startswith("finger") and not segment.startswith("1") and parent:
            new_heads[name] = new_tails[parent]
        new_tails[name] = new_heads[name] + (tails[name] - heads[name]) * stretch
    result = np.zeros_like(points)
    for index, name in enumerate(ARM_BONES):
        w = table[:, index]
        active = w > 0
        if not active.any():
            continue
        head, tail = heads[name], tails[name]
        axis = tail - head
        length = np.linalg.norm(axis)
        unit = axis / length
        stretch = np.linalg.norm(new_tails[name] - new_heads[name]) / length
        p = points[active]
        t = np.maximum((p - head) @ unit / length, 0.0)
        radial = p - head - np.outer(t * length, unit)
        inside = np.minimum(t, 1.0)
        if name.startswith("lowerarm"):
            girth = np.full(len(p), waist(name))  # the forearm wastes evenly to a bony wrist
        else:
            girth = waist(name) + (KNUCKLE - waist(name)) * np.abs(2 * inside - 1) ** 2.2
        if name.startswith("finger") and name.split("-")[1].startswith("3"):
            girth = np.where(t > 1.0, 0.86, girth)  # bony fingertips
        along = np.where(t <= 1.0, t * length * stretch, length * stretch + (t - 1.0) * length)
        new_unit = (new_tails[name] - new_heads[name]) / (length * stretch)
        moved = new_heads[name] + np.outer(along, new_unit) + radial * girth[:, None]
        result[active] += w[active, None] * moved
    for name in bones:
        bones[name]["head"], bones[name]["tail"] = new_heads[name], new_tails[name]
    return result


def nail_mask(points, bones, table):
    """1 on the backs of the distal phalanges, where the nails sit."""
    mask = np.zeros(len(points))
    back = np.array([0.0, 1.0, 0.0])  # the palm faces -Y
    for finger in range(1, 6):
        name = f"finger{finger}-3.R"
        w = table[:, ARM_BONES.index(name)]
        head, tail = bones[name]["head"], bones[name]["tail"]
        unit = (tail - head) / np.linalg.norm(tail - head)
        side = back if finger > 1 else np.cross(unit, np.array([0.0, 0.0, 1.0])) * -1 + back * 0.6
        side = side - unit * side.dot(unit)
        side /= np.linalg.norm(side)
        t = (points - head) @ unit / np.linalg.norm(tail - head)
        radial = points - head - np.outer((points - head) @ unit, unit)
        facing = (radial @ side) / np.maximum(np.linalg.norm(radial, axis=1), 1e-9)
        mask = np.maximum(mask, (w > 0.7) * np.clip((facing - 0.45) / 0.2, 0, 1) * np.clip((t - 0.3) / 0.1, 0, 1))
    return mask


# ---------------------------------------------------------------------------


def scene_reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.scale_length = 1.0
    return scene


def build(scene):
    points, faces, bones, table = load_arm()
    basis, origin = orientation(bones)
    scale = 0.1  # MakeHuman works in decimetres

    def place(p):
        return basis @ (np.asarray(p) - origin) * scale

    points = np.array([place(p) for p in points])
    for bone in bones.values():
        bone["head"], bone["tail"] = place(bone["head"]), place(bone["tail"])
    points = gaunt(points, bones, table)
    mesh = bpy.data.meshes.new("ZombieArm")
    mesh.from_pydata(points.tolist(), [], faces)
    mesh.update()
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    mesh.attributes.new("rest", "FLOAT_VECTOR", "POINT").data.foreach_set("vector", points.ravel())
    mesh.attributes.new("nail", "FLOAT", "POINT").data.foreach_set("value", nail_mask(points, bones, table))
    mesh.materials.append(skin_material())
    arm = bpy.data.objects.new("ZombieArm", mesh)
    scene.collection.objects.link(arm)

    armature_data = bpy.data.armatures.new("Rig")
    rig = bpy.data.objects.new("Rig", armature_data)
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name in ARM_BONES:
        edit = armature_data.edit_bones.new(name)
        edit.head = bones[name]["head"].tolist()
        edit.tail = bones[name]["tail"].tolist()
    for name in ARM_BONES:
        parent = bones[name]["parent"]
        if parent:
            armature_data.edit_bones[name].parent = armature_data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")

    for index, name in enumerate(ARM_BONES):
        group = arm.vertex_groups.new(name=name)
        for vertex in np.nonzero(table[:, index] > 1e-4)[0]:
            group.add([int(vertex)], float(table[vertex, index]), "REPLACE")
    arm.parent = rig
    modifier = arm.modifiers.new("Armature", "ARMATURE")
    modifier.object = rig
    modifier.use_deform_preserve_volume = True
    # Lumpy wasted tissue, displaced in the rest pose so it rides with the bones.
    lumps = bpy.data.textures.new("Lumps", "CLOUDS")
    lumps.noise_scale = 0.012
    lumps.noise_depth = 3
    displace = arm.modifiers.new("Lumps", "DISPLACE")
    displace.texture = lumps
    displace.texture_coords = "LOCAL"
    displace.strength = 0.0016
    displace.mid_level = 0.5
    subdivision = arm.modifiers.new("Subdivision", "SUBSURF")
    subdivision.levels = 2
    subdivision.render_levels = 2
    for modifier_name in ("Subdivision", "Lumps"):
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.modifier_move_to_index(modifier=modifier_name, index=0)
    print(f"arm vertices {len(points)} faces {len(faces)}")
    return arm, rig, bones


# Each finger: (MCP, PIP, DIP flexion, MCP spread) in degrees; the thumb:
# (CMC flexion, CMC opposition, MCP, IP); the wrist: (extension, ulnar
# deviation); twist turns the forearm about its own axis.
def hand_pose(fingers, thumb=(0, 0, 0, 0), wrist=(0, 0), twist=0.0):
    return dict(fingers=fingers, thumb=thumb, wrist=wrist, twist=twist)


POSES = {
    "rest": hand_pose([(0, 0, 0, 0)] * 4),
    "bunch": hand_pose([(18, 34, 22, -6), (16, 30, 20, 0), (20, 34, 22, 5), (26, 38, 24, 10)],
                       (10, 25, 12, 14), wrist=(-8, 4), twist=6),
    "flare": hand_pose([(-16, 18, 14, 20), (-18, 14, 12, 4), (-14, 18, 14, -12), (-8, 22, 18, -26)],
                       (-10, -6, -4, 10), wrist=(18, -4), twist=-8),
    "claw": hand_pose([(-4, 50, 40, 16), (-6, 54, 44, 3), (0, 56, 46, -10), (10, 58, 46, -22)],
                      (-4, 4, 10, 30), wrist=(26, -3), twist=-4),
    "fist": hand_pose([(76, 98, 62, -2), (82, 102, 64, 0), (86, 100, 62, 2), (90, 96, 58, 5)],
                      (24, 52, 34, 44), wrist=(4, 2), twist=4),
}


def blend_pose(a, b, t):
    lerp = lambda x, y: x + (y - x) * t  # noqa: E731
    return hand_pose([tuple(map(lerp, f, g)) for f, g in zip(a["fingers"], b["fingers"])],
                     tuple(map(lerp, a["thumb"], b["thumb"])), tuple(map(lerp, a["wrist"], b["wrist"])),
                     lerp(a["twist"], b["twist"]))


def apply_pose(rig, bones, pose):
    palm = V((0.0, -1.0, 0.0))
    rest = {bone.name: bone.matrix_local.to_3x3() for bone in rig.data.bones}

    def turn(name, *axis_angles):
        local = rest[name].inverted()
        quaternion = Quaternion()
        for axis, degrees in axis_angles:
            quaternion = quaternion @ Quaternion((local @ axis).normalized(), math.radians(degrees))
        rig.pose.bones[name].rotation_quaternion = quaternion

    def direction(name):
        return (V(bones[name]["tail"]) - V(bones[name]["head"])).normalized()

    up = direction("lowerarm01.R")
    turn("lowerarm01.R", (up, pose["twist"]))
    extension, deviation = pose["wrist"]
    turn("wrist.R", (palm, deviation), (direction("wrist.R").cross(palm), -extension))
    for finger, (mcp, pip, dip, spread) in zip(range(2, 6), pose["fingers"]):
        names = [f"finger{finger}-{segment}.R" for segment in (1, 2, 3)]
        flex = direction(names[0]).cross(palm)
        turn(names[0], (palm, spread), (flex, mcp))
        turn(names[1], (direction(names[1]).cross(palm), pip))
        turn(names[2], (direction(names[2]).cross(palm), dip))
    cmc, opposition, mcp, ip = pose["thumb"]
    centre = sum((V(bones[f"metacarpal{i}.R"]["tail"]) for i in range(1, 5)), V()) / 4
    thumb = [f"finger1-{segment}.R" for segment in (1, 2, 3)]
    toward = centre - V(bones[thumb[0]]["head"])
    toward = (toward - direction(thumb[0]) * toward.dot(direction(thumb[0]))).normalized()
    toward = (toward + palm * 0.8).normalized()
    turn(thumb[0], (direction("metacarpal1.R"), -opposition), (direction(thumb[0]).cross(toward), cmc))
    turn(thumb[1], (direction(thumb[1]).cross(toward), mcp))
    turn(thumb[2], (direction(thumb[2]).cross(toward), ip))
    bpy.context.view_layer.update()


def skin_material():
    material = bpy.data.materials.new("RottingSkin")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    rest = nodes.new("ShaderNodeAttribute")
    rest.attribute_name = "rest"
    nail = nodes.new("ShaderNodeAttribute")
    nail.attribute_name = "nail"

    def noise(scale, detail=6.0, roughness=0.6, vector=None):
        node = nodes.new("ShaderNodeTexNoise")
        node.inputs["Scale"].default_value = scale
        node.inputs["Detail"].default_value = detail
        node.inputs["Roughness"].default_value = roughness
        links.new(vector or rest.outputs["Vector"], node.inputs["Vector"])
        return node

    def ramp(source, stops):
        node = nodes.new("ShaderNodeValToRGB")
        elements = node.color_ramp.elements
        while len(elements) < len(stops):
            elements.new(0.5)
        for element, (position, color) in zip(elements, stops):
            element.position = position
            element.color = (*color, 1.0)
        links.new(source, node.inputs["Fac"])
        return node

    def rgb(color):
        node = nodes.new("ShaderNodeRGB")
        node.outputs[0].default_value = (*color, 1.0)
        return node.outputs[0]

    def mix(a, b, factor):
        node = nodes.new("ShaderNodeMix")
        node.data_type = "RGBA"
        links.new(factor, node.inputs["Factor"])
        links.new(a, node.inputs[6])
        links.new(b, node.inputs[7])
        return node.outputs[2]

    # Grey-green dead skin, bruised and rotting in patches.
    skin = ramp(noise(34, 8, 0.62).outputs["Fac"],
                [(0.30, (0.055, 0.066, 0.048)), (0.52, (0.15, 0.168, 0.125)), (0.76, (0.27, 0.285, 0.22))]).outputs["Color"]
    skin = mix(skin, rgb((0.11, 0.085, 0.085)), ramp(noise(8, 3, 0.5).outputs["Fac"], [(0.48, (0, 0, 0)), (0.64, (0.85, 0.85, 0.85))]).outputs["Color"])
    skin = mix(skin, rgb((0.055, 0.035, 0.028)), ramp(noise(20, 6, 0.62).outputs["Fac"], [(0.52, (0, 0, 0)), (0.63, (0.95, 0.95, 0.95))]).outputs["Color"])

    # Grave dirt climbs the forearm and packs the creases.
    separate = nodes.new("ShaderNodeSeparateXYZ")
    links.new(rest.outputs["Vector"], separate.inputs["Vector"])
    height = nodes.new("ShaderNodeMapRange")
    height.inputs["From Min"].default_value = -0.12
    height.inputs["From Max"].default_value = 0.10
    height.inputs["To Min"].default_value = 0.95
    height.inputs["To Max"].default_value = 0.0
    links.new(separate.outputs["Z"], height.inputs["Value"])
    dirt_mask = nodes.new("ShaderNodeMath")
    dirt_mask.operation = "MULTIPLY"
    links.new(height.outputs["Result"], dirt_mask.inputs[0])
    links.new(ramp(noise(70, 6, 0.7).outputs["Fac"], [(0.35, (0.25, 0.25, 0.25)), (0.62, (1, 1, 1))]).outputs["Color"], dirt_mask.inputs[1])
    dirt = rgb((0.075, 0.055, 0.04))
    skin = mix(skin, dirt, dirt_mask.outputs[0])
    tips = nodes.new("ShaderNodeMapRange")
    tips.inputs["From Min"].default_value = 0.13
    tips.inputs["From Max"].default_value = 0.21
    tips.inputs["To Min"].default_value = 0.0
    tips.inputs["To Max"].default_value = 0.85
    links.new(separate.outputs["Z"], tips.inputs["Value"])
    tip_mask = nodes.new("ShaderNodeMath")
    tip_mask.operation = "MULTIPLY"
    links.new(tips.outputs["Result"], tip_mask.inputs[0])
    links.new(ramp(noise(60, 6, 0.7).outputs["Fac"], [(0.38, (0.2, 0.2, 0.2)), (0.6, (1, 1, 1))]).outputs["Color"], tip_mask.inputs[1])
    skin = mix(skin, dirt, tip_mask.outputs[0])
    occlusion = nodes.new("ShaderNodeAmbientOcclusion")
    occlusion.inputs["Distance"].default_value = 0.008
    skin = mix(skin, dirt, ramp(occlusion.outputs["AO"], [(0.35, (0.85, 0.85, 0.85)), (0.92, (0, 0, 0))]).outputs["Color"])

    # Cracked, yellowed nails packed with dirt.
    nail_color = mix(rgb((0.20, 0.17, 0.09)), rgb((0.06, 0.045, 0.03)),
                     ramp(noise(140, 4, 0.6).outputs["Fac"], [(0.45, (0, 0, 0)), (0.6, (1, 1, 1))]).outputs["Color"])
    links.new(mix(skin, nail_color, nail.outputs["Fac"]), bsdf.inputs["Base Color"])
    roughness = nodes.new("ShaderNodeMapRange")
    roughness.inputs["To Min"].default_value = 0.8
    roughness.inputs["To Max"].default_value = 0.38
    links.new(nail.outputs["Fac"], roughness.inputs["Value"])
    links.new(roughness.outputs["Result"], bsdf.inputs["Roughness"])
    bsdf.inputs["Subsurface Weight"].default_value = 0.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.3  # dry skin, no wet sheen
    bsdf.inputs["Subsurface Radius"].default_value = (0.5, 0.22, 0.16)
    bsdf.inputs["Subsurface Scale"].default_value = 0.002

    # Dry wrinkled skin: lengthwise creases and fine pores.
    stretch = nodes.new("ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = (1.0, 1.0, 0.2)
    links.new(rest.outputs["Vector"], stretch.inputs["Vector"])
    previous = None
    for scale, detail, strength, distance, vector in ((520, 2, 0.22, 0.0003, stretch.outputs["Vector"]),
                                                      (380, 10, 0.28, 0.00025, None)):
        bump = nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = strength
        bump.inputs["Distance"].default_value = distance
        links.new(noise(scale, detail, 0.62, vector).outputs["Fac"], bump.inputs["Height"])
        if previous:
            links.new(previous.outputs["Normal"], bump.inputs["Normal"])
        previous = bump
    links.new(previous.outputs["Normal"], bsdf.inputs["Normal"])
    return material


def stage(scene):
    scene.render.engine = "CYCLES"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    try:
        preferences.compute_device_type = "METAL"
        preferences.get_devices()
        for device in preferences.devices:
            device.use = True
        scene.cycles.device = "GPU"
    except TypeError:
        scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = bpy.data.worlds.new("Night")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.05, 0.06, 0.08, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
    scene.world = world

    def light(name, location, energy, color, size):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.color = color
        data.size = size
        obj = bpy.data.objects.new(name, data)
        obj.location = location
        direction = V((0, 0, 0.05)) - V(location)
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(obj)

    light("Key", (0.55, -0.40, 0.45), 16.0, (1.0, 0.92, 0.82), 0.18)
    light("Fill", (-0.5, -0.6, 0.0), 2.5, (0.75, 0.85, 1.0), 0.6)
    light("Moon", (-0.36, 0.46, 0.34), 90.0, (0.62, 0.76, 1.0), 0.14)
    light("MoonRight", (0.38, 0.40, 0.14), 16.0, (0.6, 0.74, 1.0), 0.12)

    camera_data = bpy.data.cameras.new("Camera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 0.50
    camera = bpy.data.objects.new("Camera", camera_data)
    camera.location = (0.0, -1.0, -0.02)
    camera.rotation_euler = (math.radians(90), 0.0, 0.0)
    scene.collection.objects.link(camera)
    scene.camera = camera
    return camera


# Frames: the view angle, pixel density and the rig unit grave.ts draws in
# (the hand is about 120 rig units from wrist to fingertip).
VIEW_ANGLE = -25.0
PX_PER_METRE = 1829.0  # 2x device pixels at the effect's hand scale
METRES_PER_UNIT = 0.00175
FRAME_WINDOW = (-0.17, 0.17, -0.17, 0.25)  # x and z extents; the cut forearm stays underground
RISE = [(0.0, "bunch"), (0.45, "flare"), (1.0, "claw")]
RISE_FRAMES = 12
GRAB_FRAMES = 8


def smooth(x):
    return x * x * (3 - 2 * x)


def rise_pose(s):
    for (a, name_a), (b, name_b) in zip(RISE, RISE[1:]):
        if s <= b:
            return blend_pose(POSES[name_a], POSES[name_b], smooth((s - a) / (b - a)))
    return POSES[RISE[-1][1]]


def render_frames(scene, camera, arm, rig, bones):
    left, right, bottom, top = FRAME_WINDOW
    width, height = right - left, top - bottom
    scene.render.resolution_x = round(width * PX_PER_METRE)
    scene.render.resolution_y = round(height * PX_PER_METRE)
    camera.data.ortho_scale = max(width, height)
    camera.location = ((left + right) / 2, -1.0, (bottom + top) / 2)
    rig.rotation_euler = (0.0, 0.0, math.radians(VIEW_ANGLE))
    res_x, res_y = scene.render.resolution_x, scene.render.resolution_y

    def project(point):
        view = world_to_camera_view(scene, camera, V(point))
        return [view.x * res_x, (1 - view.y) * res_y]

    grip_bones = [f"finger{f}-{s}.R" for f in range(2, 6) for s in (1, 2)]
    frames = []
    sequence = [("rise", i, rise_pose(i / (RISE_FRAMES - 1))) for i in range(RISE_FRAMES)]
    sequence += [("grab", i, blend_pose(POSES["claw"], POSES["fist"], smooth(i / (GRAB_FRAMES - 1))))
                 for i in range(GRAB_FRAMES)]
    for label, index, pose in sequence:
        apply_pose(rig, bones, pose)
        path = os.path.join(OUT, f"frame-{label}-{index:02d}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        heads = [rig.matrix_world @ rig.pose.bones[name].head for name in grip_bones]
        frames.append(dict(path=path, grip=project(sum(heads, V()) / len(heads))))
    anchor = project((0.0, 0.0, 0.0))  # the wrist, which the rig is drawn around

    # Crop every frame to the union of their silhouettes and tile them.
    images = []
    for frame in frames:
        image = bpy.data.images.load(frame["path"])
        pixels = np.array(image.pixels[:], dtype=np.float32).reshape(res_y, res_x, 4)[::-1]
        images.append(pixels)
        bpy.data.images.remove(image)
    alpha = np.max([image[..., 3] for image in images], axis=0)
    rows, columns = np.nonzero(alpha > 0.01)
    pad = 4
    x0, x1 = max(columns.min() - pad, 0), min(columns.max() + pad + 1, res_x)
    y0, y1 = max(rows.min() - pad, 0), min(rows.max() + pad + 1, res_y)
    frame_w, frame_h = int(x1 - x0), int(y1 - y0)
    across = 5
    down = math.ceil(len(images) / across)
    atlas = np.zeros((down * frame_h, across * frame_w, 4), dtype=np.float32)
    for index, image in enumerate(images):
        row, column = divmod(index, across)
        atlas[row * frame_h:(row + 1) * frame_h, column * frame_w:(column + 1) * frame_w] = image[y0:y1, x0:x1]
    sheet = bpy.data.images.new("Atlas", across * frame_w, down * frame_h, alpha=True)
    sheet.pixels[:] = atlas[::-1].ravel()
    sheet.filepath_raw = os.path.join(OUT, "atlas.png")
    sheet.file_format = "PNG"
    sheet.save()

    units_per_px = 1.0 / (PX_PER_METRE * METRES_PER_UNIT)

    def to_units(point):
        return [round((point[0] - anchor[0]) * units_per_px, 2), round((point[1] - anchor[1]) * units_per_px, 2)]

    meta = dict(
        frame=dict(width=frame_w, height=frame_h), columns=across,
        rise=RISE_FRAMES, grab=GRAB_FRAMES,
        anchor=dict(x=round(anchor[0] - x0, 2), y=round(anchor[1] - y0, 2)),
        unitsPerPx=round(units_per_px, 5),
        grip=[to_units(frame["grip"]) for frame in frames[RISE_FRAMES:]],
    )
    with open(os.path.join(OUT, "atlas.json"), "w") as handle:
        json.dump(meta, handle, indent=2)
    print("atlas", json.dumps(meta))


def main():
    scene = scene_reset()
    arm, rig, bones = build(scene)
    for bone in rig.pose.bones:
        bone.rotation_mode = "QUATERNION"
    camera = stage(scene)
    if MODE == "frames":
        render_frames(scene, camera, arm, rig, bones)
    if MODE == "look":
        scene.render.resolution_x, scene.render.resolution_y = 420, 800
        names = ARGS[3].split(",") if len(ARGS) > 3 else ["bunch", "flare", "claw", "fist"]
        angle = float(ARGS[4]) if len(ARGS) > 4 else VIEW_ANGLE
        rig.rotation_euler = (0.0, 0.0, math.radians(angle))
        for name in names:
            apply_pose(rig, bones, POSES[name])
            scene.render.filepath = os.path.join(OUT, f"look-{name}.png")
            bpy.ops.render.render(write_still=True)
            if len(ARGS) > 5:  # a profile check of the same pose
                rig.rotation_euler = (0.0, 0.0, math.radians(float(ARGS[5])))
                scene.render.filepath = os.path.join(OUT, f"look-{name}-profile.png")
                bpy.ops.render.render(write_still=True)
                rig.rotation_euler = (0.0, 0.0, math.radians(angle))
    if MODE == "rest":
        scene.render.resolution_x, scene.render.resolution_y = 400, 800
        for label, angle in (("front", 0), ("side", 90), ("back", 180)):
            rig.rotation_euler = (0.0, 0.0, math.radians(angle))
            scene.render.filepath = os.path.join(OUT, f"rest-{label}.png")
            bpy.ops.render.render(write_still=True)
    print("done")


main()
