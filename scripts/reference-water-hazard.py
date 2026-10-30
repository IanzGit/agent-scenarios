"""只读加载原项目纯计算函数，生成迁移对照数据。开发工具，不进入发布包。
用法：python scripts/reference-water-hazard.py <原water_hazard工具目录>
需要 numpy/scipy/pykrige/pandas/matplotlib；无需原服务、LangChain、模型或业务网络。
"""
import ast
import csv
import json
import math
import random
import sys
import types
from datetime import datetime
from pathlib import Path

root = Path(sys.argv[1])
output = Path(__file__).resolve().parents[1] / 'packages/water-hazard/tests/fixtures/reference.json'

def load(name, filename, bindings):
    tree = ast.parse((root / filename).read_text())
    tree.body = [node for node in tree.body if not isinstance(node, ast.ImportFrom) or not node.level]
    module = types.ModuleType(name)
    sys.modules[name] = module
    module.__dict__.update(bindings)
    exec(compile(tree, str(root / filename), 'exec'), module.__dict__)
    return module

constants = load('reference_constants', 'constants.py', {})
roof = load('reference_roof', 'business/analyze_roof_water_warning.py', vars(constants))

def csv_rows(name):
    with (root / 'assets' / name).open(encoding='utf-8-sig') as source:
        return list(csv.DictReader(source))

richness = roof.compute_water_richness([{'编号': row['编号'], 'X': float(row['X']), 'Y': float(row['Y']), '单位涌水量': float(row['单位涌水量'])} for row in csv_rows('water_inflow.csv')])
channel = roof.compute_water_channel([{'编号': row['编号'], 'X': float(row['X']), 'Y': float(row['Y']), '煤层厚度': float(row['煤层厚度']), '隔水层厚度': float(row['隔水层厚度']), '岩性': row['岩性']} for row in csv_rows('borehole_data.csv')])
hazard = roof.compute_hazard_risk(richness, channel)
boundary = roof.load_boundary_points_from_rows([{'X': float(row['X']), 'Y': float(row['Y'])} for row in csv_rows('mine_boundary.csv')])
bounds = {row['workface_name']: [(float(row[f'x{i}']), float(row[f'y{i}'])) for i in range(1, 5)] for row in csv_rows('workfaces_boundary.csv')}
static = {}
from pykrige.ok import OrdinaryKriging
for kind, points, field in [('richness', richness, 'unit_inflow'), ('channel', channel, 'thickness'), ('hazard', hazard, 'hazard_index')]:
    model = OrdinaryKriging([p['x'] for p in points], [p['y'] for p in points], [p[field] for p in points], variogram_model='spherical')
    grid = roof._compute_kriging_interpolate(points, field, boundary)
    static[kind] = {'parameters': model.variogram_model_parameters.tolist(), 'points': [{'id': p['id'], 'x': p['x'], 'y': p['y'], 'value': p[field], 'level': p['level']} for p in points],
                    'samples': [[i, j, grid['Z_masked'][i][j]] for i in range(0, 150, 7) for j in range(0, 150, 7) if math.isfinite(grid['Z_masked'][i][j])],
                    'levels': {face: roof._get_workface_level(grid, polygon, constants.WATER_LEVELS[kind], 'min' if kind == 'channel' else 'max') for face, polygon in bounds.items()}}

dynamic = []
for pressure in [0, .1399, .14, .18, .22, .26, .4]:
    for ph in [4.9, 5, 5.5, 6, 6.5, 8.5, 9, 9.5, 10, 10.1]:
        values = {'inflow': [40.0] * 30, 'borehole': [20.0] * 30, 'quality': [ph] * 30, 'pressure': [pressure] * 30, 'thresholds': [.14, .18, .22, .26], 'distance': 90.0}
        expected = roof.evaluate_dynamic_indicators(
            [{'daily_inflow': v, 'unit': 'm³/h'} for v in values['inflow']], [{'water_level': v, 'unit': 'm'} for v in values['borehole']],
            [{'ph': v, 'unit': 'PH'} for v in values['quality']], [{'value': v, 'unit': 'MPa', 'date': '2026-08-30', 'source_name': '85212辅撤回通道'} for v in values['pressure']],
            dict(zip(['blue', 'yellow', 'orange', 'red'], values['thresholds'])), {'distance': values['distance']})
        dynamic.append({'input': values, 'levels': [v['level'] for v in expected], 'basis': [v['judge_basis'] for v in expected]})

random.seed(17)
comprehensive = []
keys = ['water_inflow', 'aquifer_water_level', 'water_quality', 'structure_distance', 'water_pressure']
for i in range(120):
    levels = [random.randrange(5) for _ in keys]
    static_levels = [random.randrange(5) for _ in range(3)]
    value = roof.build_comprehensive_warning_result(workface='85211', static_levels=static_levels, dynamic_indicators=[{'key': key, 'level': level, 'judge_basis': ''} for key, level in zip(keys, levels)])
    comprehensive.append({'static': static_levels, 'dynamic': levels, 'warning': value['综合预警等级'], 'analysis': value['综合指标分析结果表']})

simulation = load('reference_simulation', 'business/local_inrush_simulation.py', {})
N = lambda i, x, y, z, end=False: types.SimpleNamespace(node_ori_id=i, x=x, y=y, z=z, name=f'节点{i}', is_exit=end)
R = lambda i, start, end, closed=0: types.SimpleNamespace(roadway_ori_id=i, start_node_ori_id=start, end_node_ori_id=end, width=3, height=2, closed=closed, name=f'巷道{i}')
nodes = [N(1,100,100,10),N(2,200,100,8),N(3,300,100,6,True),N(4,200,200,9),N(5,300,200,9,True)]
roadways = [R(11,1,2),R(12,2,3),R(13,2,4),R(14,4,5,1)]
people = [types.SimpleNamespace(staff_id=1,name='甲',x=110,y=100,z=10),types.SimpleNamespace(staff_id=2,name='乙',x=290,y=200,z=9)]
sim = simulation.InrushSimulator
mesh = sim.generate_mesh(nodes, roadways)
process = sim.flooding_simulate(mesh,1,.5)
simulations = []
for time in [0,60,1000,86400]:
    state = sim.submerge_state(mesh,process,time)
    routes = sim.build_escape_result(nodes,sim.escape_route(mesh,state,people,[3,5],time),[nodes[2],nodes[4]])
    simulations.append({'time': time,'states': {str(row['roadway_ori_id']): {'type':row['sub_type'],'fraction':row['sub_fraction']} for row in state.entries},'routes':routes})

# 复盘对照包括缺日、日内极值、日末值和背景监测范围。
api_tree = ast.parse((root / 'api_service.py').read_text())
functions = [node for node in api_tree.body if isinstance(node, ast.FunctionDef) and node.name in ['daily_last_valid','_monitoring_value']]
api = types.ModuleType('reference_api');sys.modules[api.__name__]=api
api.__dict__.update({'math':math,'datetime':datetime,'Any':object})
exec(compile(ast.Module(body=functions,type_ignores=[]),'api_service.py','exec'),api.__dict__)
review = load('reference_review','business/get_hydrological_review.py',{'api_service':api})
records = []
for day in range(1,9):
    for metric, value, source, unit in [('涌水量',40+day*2,'85211涌水量','m³/h'),('长观孔水位',20-day*.6,'第四系钻孔ZK4','m'),('排水量',60,'八盘区水泵房','m³/h')]:
        records.append({'date':f'2026-08-{day:02d} 15:00:00','value':value,'metric_name':metric,'source_name':source,'sensor_name':metric,'unit':unit,'监测范围':'85211工作面' if metric=='涌水量' else '背景'})
records.append({**records[0],'date':'2026-08-01 01:00:00','value':150})
frame=review._build_frame(records)
from datetime import date
quality,statistics=review._build_quality_and_statistics(records,frame,date(2026,8,1),date(2026,8,10))
review_result={'records':records,'quality':quality,'statistics':statistics,'precursors':review._detect_warning_precursors(frame),'response':review._build_water_response(frame)}

output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps({'static':static,'dynamic':dynamic,'comprehensive':comprehensive,'simulations':simulations,'review':review_result},ensure_ascii=False,allow_nan=False,separators=(',',':'))+'\n')
print(f'已生成 {output}')
