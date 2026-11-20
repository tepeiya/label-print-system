<template>
  <div class="page">
    <div class="page-head">
      <h2>基础资料</h2>
      <span class="hint">产品资料、仓库与库位；停用而非删除，已被引用的资料会被保护</span>
    </div>

    <el-tabs v-model="tab">
      <!-- 产品资料 -->
      <el-tab-pane label="产品资料" name="materials">
        <div class="filters">
          <el-input v-model="matKeyword" placeholder="编码 / 名称 / 规格" clearable style="width: 240px"
                    @keyup.enter="loadMaterials" />
          <el-checkbox v-model="matShowInactive">显示已停用</el-checkbox>
          <el-button type="primary" @click="loadMaterials">查询</el-button>
          <el-button v-if="canWrite" style="margin-left:auto" :disabled="!selectedMaterials.length"
                     @click="openBind('selected')">批量绑定（已选 {{ selectedMaterials.length }}）</el-button>
          <el-button v-if="canWrite" :disabled="!selectedMaterials.length" @click="openLocBind()">批量设位置</el-button>
          <el-button v-if="canWrite" @click="openFieldMgr()">自定义字段</el-button>
          <el-button v-if="canWrite" type="success" @click="openMat()">+ 新增产品</el-button>
        </div>
        <el-table :data="materials" v-loading="matLoading" border stripe size="small"
                  @selection-change="onMatSelection">
          <el-table-column type="selection" width="46" />
          <el-table-column prop="code" label="编码" min-width="140" />
          <el-table-column prop="name" label="名称" min-width="150" />
          <el-table-column prop="spec" label="规格" min-width="140" />
          <el-table-column prop="unit" label="单位" width="80" />
          <el-table-column prop="category" label="类别" width="110" />
          <el-table-column v-for="f in activeFields" :key="f.fieldKey" :label="f.label" min-width="110">
            <template #default="{ row }">
              <span>{{ formatCustomValue(row.customFields?.[f.fieldKey]) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="分组" min-width="120">
            <template #default="{ row }">{{ row.groupName || '—' }}</template>
          </el-table-column>
          <el-table-column label="自动打印" width="100">
            <template #default="{ row }">
              <el-tag v-if="row.autoPrint" type="success" size="small">开</el-tag>
              <span v-else class="muted">关</span>
            </template>
          </el-table-column>
          <el-table-column prop="safetyStock" label="安全库存" width="110" align="right" />
          <el-table-column label="标签模板" min-width="150">
            <template #default="{ row }">
              <span v-if="row.templateName">{{ row.templateName }}</span>
              <span v-else class="muted">未绑定</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="240" fixed="right">
            <template #default="{ row }">
              <el-button v-if="canPrint" size="small" type="primary" :disabled="!row.templateName"
                         @click="openPrint(row)">打印条码</el-button>
              <template v-if="canWrite">
                <el-button size="small" @click="openMat(row)">编辑</el-button>
                <el-button size="small" :type="row.active ? 'danger' : 'success'" @click="toggleMat(row)">
                  {{ row.active ? '停用' : '启用' }}
                </el-button>
              </template>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无产品资料" /></template>
        </el-table>
      </el-tab-pane>

      <!-- 产品分组 -->
      <el-tab-pane label="产品分组" name="groupsPane">
        <div class="filters">
          <el-select v-model="groupTypeFilter" placeholder="全部分组类型" clearable style="width:170px"
                     @change="loadGroups">
            <el-option label="品牌" value="brand" />
            <el-option label="供应商" value="supplier" />
            <el-option label="自定义" value="custom" />
          </el-select>
          <el-button type="primary" @click="loadGroups">刷新</el-button>
          <el-button v-if="canWrite" type="success" style="margin-left:auto" @click="openGroup()">+ 新增分组</el-button>
        </div>
        <el-table :data="groups" v-loading="groupLoading" border stripe size="small">
          <el-table-column prop="code" label="编码" min-width="130" />
          <el-table-column prop="name" label="分组名称" min-width="180" />
          <el-table-column label="类型" width="110">
            <template #default="{ row }">{{ typeLabel(row.type) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="canWrite" label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="openGroup(row)">编辑</el-button>
              <el-button size="small" :type="row.active ? 'danger' : 'success'" @click="toggleGroup(row)">
                {{ row.active ? '停用' : '启用' }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无产品分组" /></template>
        </el-table>
      </el-tab-pane>

      <!-- 仓库 -->
      <el-tab-pane label="仓库" name="warehouses">
        <div class="filters">
          <el-checkbox v-model="whShowInactive">显示已停用</el-checkbox>
          <el-button type="primary" @click="loadWarehouses">刷新</el-button>
          <el-button v-if="canWrite" type="success" style="margin-left:auto" @click="openWh()">+ 新增仓库</el-button>
        </div>
        <el-table :data="warehouses" v-loading="whLoading" border stripe size="small">
          <el-table-column prop="code" label="编码" min-width="150" />
          <el-table-column prop="name" label="仓库名称" min-width="200" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="canWrite" label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="openWh(row)">编辑</el-button>
              <el-button size="small" :type="row.active ? 'danger' : 'success'" @click="toggleWh(row)">
                {{ row.active ? '停用' : '启用' }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无仓库" /></template>
        </el-table>
      </el-tab-pane>

      <!-- 库位 -->
      <el-tab-pane label="库位" name="locations">
        <div class="filters">
          <el-select v-model="locWarehouse" placeholder="全部仓库" clearable style="width: 180px">
            <el-option v-for="w in activeWarehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
          <el-input v-model="locKeyword" placeholder="编码 / 名称 / 库区" clearable style="width: 220px"
                    @keyup.enter="loadLocations" />
          <el-checkbox v-model="locShowInactive">显示已停用</el-checkbox>
          <el-button type="primary" @click="loadLocations">查询</el-button>
          <el-button v-if="canWrite" type="success" style="margin-left:auto" @click="openLoc()">+ 新增库位</el-button>
        </div>
        <el-table :data="locations" v-loading="locLoading" border stripe size="small">
          <el-table-column prop="warehouse" label="所属仓库" min-width="150" />
          <el-table-column prop="code" label="库位编码" min-width="130" />
          <el-table-column prop="name" label="库位名称" min-width="160" />
          <el-table-column prop="zone" label="库区" min-width="110" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="canWrite" label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="openLoc(row)">编辑</el-button>
              <el-button size="small" :type="row.active ? 'danger' : 'success'" @click="toggleLoc(row)">
                {{ row.active ? '停用' : '启用' }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无库位，先给仓库划分库位吧" /></template>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 产品资料弹窗 -->
    <el-dialog v-model="matDialog" :title="matForm.id ? '编辑产品' : '新增产品'" width="480px">
      <el-form :model="matForm" label-width="100px">
        <el-form-item label="编码" required>
          <el-input v-model="matForm.code" :disabled="!!matForm.id" placeholder="如 M-APPLE-ORG" />
        </el-form-item>
        <el-form-item label="名称" required><el-input v-model="matForm.name" /></el-form-item>
        <el-form-item label="规格"><el-input v-model="matForm.spec" /></el-form-item>
        <el-form-item label="单位"><el-input v-model="matForm.unit" placeholder="件 / kg / 张" /></el-form-item>
        <el-form-item label="类别"><el-input v-model="matForm.category" placeholder="水果 / 包材 / 耗材" /></el-form-item>
        <el-form-item label="安全库存">
          <el-input-number v-model="matForm.safetyStock" :min="0" :precision="3" style="width:100%" />
        </el-form-item>
        <el-form-item label="标签模板">
          <el-select v-model="matForm.templateId" clearable filterable placeholder="绑定后可直接打印条码"
                     style="width:100%">
            <el-option v-for="t in templates" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
          <div class="field-hint">模板里用 <span v-text="'{{code}}'" /> / <span v-text="'{{batchNo}}'" /> 等占位，打印时自动替换为产品与批次数据</div>
        </el-form-item>
        <el-form-item label="产品分组">
          <el-select v-model="matForm.groupId" clearable filterable placeholder="用于按分组批量绑定" style="width:100%">
            <el-option v-for="g in groups" :key="g.id" :label="`${typeLabel(g.type)} · ${g.name}`" :value="g.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="入库自动打印">
          <el-checkbox v-model="matForm.autoPrint" :disabled="!matForm.templateId">
            入库后自动按模板出签（未绑定模板时不可开启）
          </el-checkbox>
        </el-form-item>
        <el-form-item label="打印打印机">
          <el-select v-model="matForm.printerId" clearable filterable placeholder="留空用系统默认打印机" style="width:100%">
            <el-option v-for="p in printers" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认仓库">
          <el-select v-model="matForm.defaultWarehouseId" clearable filterable placeholder="入库缺省时自动带入"
                     style="width:100%" @change="matForm.defaultLocationId = undefined">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认库位">
          <el-select v-model="matForm.defaultLocationId" clearable filterable placeholder="留空只定位到仓库"
                     :disabled="!matForm.defaultWarehouseId" style="width:100%">
            <el-option v-for="l in locations.filter(x => x.warehouseId === matForm.defaultWarehouseId)"
                       :key="l.id" :label="`${l.code} · ${l.name}`" :value="l.id" />
          </el-select>
        </el-form-item>
        <!-- 自定义字段（按字段定义动态渲染） -->
        <el-divider content-position="left" v-if="activeFields.length">自定义字段</el-divider>
        <el-form-item v-for="f in activeFields" :key="f.fieldKey"
                      :label="f.label" :required="f.required">
          <el-input v-if="f.type === 'text'" v-model="matForm.customFields[f.fieldKey]"
                    :placeholder="`请输入${f.label}`" clearable />
          <el-input-number v-else-if="f.type === 'number'" v-model="matForm.customFields[f.fieldKey]"
                           :precision="3" controls-position="right" style="width:100%" />
          <el-date-picker v-else-if="f.type === 'date'" v-model="matForm.customFields[f.fieldKey]"
                          type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width:100%" />
          <el-select v-else-if="f.type === 'select'" v-model="matForm.customFields[f.fieldKey]"
                     clearable filterable :placeholder="`请选择${f.label}`" style="width:100%">
            <el-option v-for="opt in f.options" :key="opt" :label="opt" :value="opt" />
          </el-select>
          <el-select v-else-if="f.type === 'multiselect'" v-model="matForm.customFields[f.fieldKey]"
                     multiple clearable filterable :placeholder="`可多选${f.label}`" style="width:100%">
            <el-option v-for="opt in f.options" :key="opt" :label="opt" :value="opt" />
          </el-select>
          <el-switch v-else-if="f.type === 'boolean'" v-model="matForm.customFields[f.fieldKey]" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="matDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveMat">保存</el-button>
      </template>
    </el-dialog>

    <!-- 自定义字段管理弹窗 -->
    <el-dialog v-model="fieldMgrDialog" title="产品自定义字段" width="680px">
      <div class="field-mgr-tip">
        在这里定义产品可填写的额外字段；定义后即可在新增/编辑产品时填写，并可用于标签模板占位符
        <code v-text="'{{field_key}}'" /> 或 <code>中文名</code>。停用字段不会删除已有数据，但不再显示与校验。
      </div>
      <div class="filters" style="margin:8px 0">
        <el-checkbox v-model="fieldShowInactive" @change="loadFields">显示已停用</el-checkbox>
        <el-button type="primary" size="small" style="margin-left:auto" @click="openField()">+ 新增字段</el-button>
      </div>
      <el-table :data="allFields" border stripe size="small" v-loading="fieldLoading">
        <el-table-column prop="label" label="字段名称" min-width="110" />
        <el-table-column prop="fieldKey" label="标识" min-width="120">
          <template #default="{ row }"><code>{{ row.fieldKey }}</code></template>
        </el-table-column>
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">{{ fieldTypeLabel(row.type) }}</template>
        </el-table-column>
        <el-table-column label="必填" width="70">
          <template #default="{ row }">{{ row.required ? '是' : '否' }}</template>
        </el-table-column>
        <el-table-column label="选项" min-width="130">
          <template #default="{ row }">{{ row.options?.join(' / ') || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openField(row)">编辑</el-button>
            <el-button size="small" :type="row.active ? 'danger' : 'success'" @click="toggleField(row)">
              {{ row.active ? '停用' : '启用' }}
            </el-button>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无自定义字段" /></template>
      </el-table>
      <template #footer>
        <el-button @click="fieldMgrDialog = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 单条字段定义编辑弹窗 -->
    <el-dialog v-model="fieldDialog" :title="fieldForm.id ? '编辑字段' : '新增字段'" width="460px"
               append-to-body>
      <el-form :model="fieldForm" label-width="92px">
        <el-form-item label="字段名称" required>
          <el-input v-model="fieldForm.label" placeholder="如 保质期 / 产地" :disabled="!!fieldForm.id" />
        </el-form-item>
        <el-form-item label="字段标识" required>
          <el-input v-model="fieldForm.fieldKey" placeholder="如 shelf_life（小写字母/数字/下划线）"
                    :disabled="!!fieldForm.id" />
          <div class="field-hint">用于标签占位符 <span v-text="'{{shelf_life}}'" />，字母开头、不可与内置字段冲突</div>
        </el-form-item>
        <el-form-item label="类型" required>
          <el-select v-model="fieldForm.type" style="width:100%">
            <el-option v-for="t in FIELD_TYPES" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="选项" v-if="fieldForm.type === 'select' || fieldForm.type === 'multiselect'">
          <el-select v-model="fieldForm.options" multiple filterable allow-create default-first-option
                     placeholder="输入后回车添加选项" style="width:100%" />
        </el-form-item>
        <el-form-item label="必填">
          <el-switch v-model="fieldForm.required" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="fieldForm.sortOrder" :min="0" controls-position="right" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="fieldDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveField">保存</el-button>
      </template>
    </el-dialog>

    <!-- 仓库弹窗 -->
    <el-dialog v-model="whDialog" :title="whForm.id ? '编辑仓库' : '新增仓库'" width="440px">
      <el-form :model="whForm" label-width="100px">
        <el-form-item label="编码" required>
          <el-input v-model="whForm.code" :disabled="!!whForm.id" placeholder="如 WH-SH" />
        </el-form-item>
        <el-form-item label="仓库名称" required><el-input v-model="whForm.name" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="whDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveWh">保存</el-button>
      </template>
    </el-dialog>

    <!-- 产品分组弹窗 -->
    <el-dialog v-model="groupDialog" :title="groupForm.id ? '编辑分组' : '新增分组'" width="440px">
      <el-form :model="groupForm" label-width="100px">
        <el-form-item label="编码" required>
          <el-input v-model="groupForm.code" :disabled="!!groupForm.id" placeholder="如 BRAND-ACME" />
        </el-form-item>
        <el-form-item label="名称" required><el-input v-model="groupForm.name" /></el-form-item>
        <el-form-item label="类型">
          <el-select v-model="groupForm.type" style="width:100%">
            <el-option label="品牌" value="brand" />
            <el-option label="供应商" value="supplier" />
            <el-option label="自定义" value="custom" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认仓库">
          <el-select v-model="groupForm.defaultWarehouseId" clearable filterable placeholder="组内产品未单独设置时继承"
                     style="width:100%" @change="groupForm.defaultLocationId = undefined">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认库位">
          <el-select v-model="groupForm.defaultLocationId" clearable filterable placeholder="留空只到仓库"
                     :disabled="!groupForm.defaultWarehouseId" style="width:100%">
            <el-option v-for="l in locations.filter(x => x.warehouseId === groupForm.defaultWarehouseId)"
                       :key="l.id" :label="`${l.code} · ${l.name}`" :value="l.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="groupDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveGroup">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量设置默认位置 -->
    <el-dialog v-model="locBindDialog" title="批量设置默认仓库 / 库位" width="500px">
      <el-form label-width="100px">
        <el-form-item label="范围">
          <el-radio-group v-model="locBindForm.scope">
            <el-radio value="selected">已选中的 {{ selectedMaterials.length }} 个产品</el-radio>
            <el-radio value="group">整个产品分组</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="locBindForm.scope === 'group'" label="产品分组">
          <el-select v-model="locBindForm.groupId" filterable style="width:100%">
            <el-option v-for="g in groups" :key="g.id" :label="`${typeLabel(g.type)} · ${g.name}`" :value="g.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认仓库">
          <el-select v-model="locBindForm.warehouseId" clearable filterable style="width:100%"
                     @change="locBindForm.locationId = undefined">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认库位">
          <el-select v-model="locBindForm.locationId" clearable filterable
                     :disabled="!locBindForm.warehouseId" style="width:100%">
            <el-option v-for="l in locations.filter(x => x.warehouseId === locBindForm.warehouseId)"
                       :key="l.id" :label="`${l.code} · ${l.name}`" :value="l.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="field-hint">产品未单独设置时会自动继承所属分组的默认位置；入库不填仓库/库位时按此配置自动带入。</div>
      <template #footer>
        <el-button @click="locBindDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitLocBind">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量绑定模板 -->
    <el-dialog v-model="bindDialog" title="批量绑定标签模板" width="520px">
      <el-form label-width="100px">
        <el-form-item label="标签模板">
          <el-select v-model="bindForm.templateId" clearable filterable placeholder="不选 = 解除绑定" style="width:100%">
            <el-option label="（解除绑定）" :value="null" />
            <el-option v-for="t in templates" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="绑定范围">
          <el-radio-group v-model="bindForm.scope">
            <el-radio value="selected">已选中的 {{ selectedMaterials.length }} 个产品</el-radio>
            <el-radio value="group">按产品分组</el-radio>
            <el-radio value="category">按产品类别</el-radio>
            <el-radio value="unbound">所有未绑定模板的产品</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="bindForm.scope === 'group'" label="产品分组">
          <el-select v-model="bindForm.groupId" filterable placeholder="选择分组" style="width:100%">
            <el-option v-for="g in groups" :key="g.id" :label="`${typeLabel(g.type)} · ${g.name}`" :value="g.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="bindForm.scope === 'category'" label="产品类别">
          <el-select v-model="bindForm.category" filterable placeholder="选择类别" style="width:100%">
            <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="field-hint">按类别 / 未绑定范围操作的是全部匹配产品，不受当前列表显示条数限制；范围之间可叠加。</div>
      <template #footer>
        <el-button @click="bindDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitBind">确认绑定</el-button>
      </template>
    </el-dialog>

    <!-- 产品一键打印条码 -->
    <el-dialog v-model="printDialog" :title="`打印条码 · ${printProduct?.name || ''}`" width="560px">
      <div class="print-info">
        <div>产品：<b>{{ printProduct?.code }} · {{ printProduct?.name }}</b></div>
        <div>模板：<b>{{ printProduct?.templateName }}</b></div>
      </div>
      <el-form :model="printForm" label-width="100px">
        <el-form-item label="打印机" required>
          <el-select v-model="printForm.printerId" filterable placeholder="选择出纸的打印机" style="width:100%">
            <el-option v-for="p in printers" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="份数">
          <el-input-number v-model="printForm.copies" :min="1" :max="500" />
        </el-form-item>
        <el-form-item label="按批次打印">
          <el-checkbox v-model="printForm.useBatches">勾选批次后每个批次出一张；不勾选则只打一张产品签</el-checkbox>
        </el-form-item>
        <el-form-item v-if="printForm.useBatches" label="选择批次">
          <el-checkbox-group v-model="printForm.batchNos" class="batch-list">
            <el-checkbox v-for="b in productBatches" :key="b.batchNo" :value="b.batchNo">
              {{ b.batchNo }} · {{ b.qty }}{{ b.unit }}<span v-if="b.expiresAt"> · 到期 {{ b.expiresAt }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <div v-if="!productBatches.length" class="muted">该产品暂无库存批次</div>
        </el-form-item>
      </el-form>
      <div class="field-hint">模板里用 <span v-text="'{{code}}'" /> / <span v-text="'{{batchNo}}'" /> 占位，打印时自动替换</div>
      <template #footer>
        <el-button @click="printDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitPrint">提交打印</el-button>
      </template>
    </el-dialog>

    <!-- 库位弹窗 -->
    <el-dialog v-model="locDialog" :title="locForm.id ? '编辑库位' : '新增库位'" width="460px">
      <el-form :model="locForm" label-width="100px">
        <el-form-item label="所属仓库" required>
          <el-select v-model="locForm.warehouseId" filterable :disabled="!!locForm.id" style="width:100%">
            <el-option v-for="w in activeWarehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="编码" required><el-input v-model="locForm.code" :disabled="!!locForm.id" placeholder="如 A-01-02" /></el-form-item>
        <el-form-item label="名称" required><el-input v-model="locForm.name" placeholder="如 A区1排2号" /></el-form-item>
        <el-form-item label="库区"><el-input v-model="locForm.zone" placeholder="如 A区 / 冷链区" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="locDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveLoc">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import {
  apiMdMaterials, apiMdCreateMaterial, apiMdUpdateMaterial, apiMdMaterialActive,
  apiMdWarehouses, apiMdCreateWarehouse, apiMdUpdateWarehouse, apiMdWarehouseActive,
  apiMdLocations, apiMdCreateLocation, apiMdUpdateLocation, apiMdLocationActive,
  apiMdPrintMaterial, apiListPrinters, apiQueryStock,
  apiMdMaterialCategories, apiMdBindTemplate,
  apiMdGroups, apiMdCreateGroup, apiMdUpdateGroup, apiMdGroupActive,
  apiMdSetDefaultLocation,
  apiMdFields, apiMdCreateField, apiMdUpdateField, apiMdFieldActive,
} from '@/api';
import { apiListTemplates } from '@/api/templates';
import { useAuthStore } from '@/store/auth';

const FIELD_TYPES = [
  { value: 'text', label: '单行文本' }, { value: 'number', label: '数字' },
  { value: 'date', label: '日期' }, { value: 'select', label: '单选' },
  { value: 'multiselect', label: '多选' }, { value: 'boolean', label: '开关' },
];
function fieldTypeLabel(t: string) { return FIELD_TYPES.find((x) => x.value === t)?.label || t; }
function formatCustomValue(v: any) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.join('、');
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

const canWrite = computed(() => useAuthStore().hasPermission('masterdata:item:write'));
const canPrint = computed(() => useAuthStore().hasPermission('print:job:write'));

const tab = ref('materials');
const saving = ref(false);
const templates = ref<any[]>([]);
const printers = ref<any[]>([]);

const materials = ref<any[]>([]);
const matKeyword = ref('');
const matShowInactive = ref(false);
const matLoading = ref(false);
const matDialog = ref(false);
const matForm = reactive<any>({
  id: null, code: '', name: '', spec: '', unit: '件', category: '', safetyStock: 0,
  templateId: undefined, groupId: undefined, autoPrint: false, printerId: undefined,
  defaultWarehouseId: undefined, defaultLocationId: undefined, customFields: {},
});

// 产品自定义字段
const allFields = ref<any[]>([]);       // 字段定义（含停用，管理弹窗用）
const fieldShowInactive = ref(false);
const fieldLoading = ref(false);
const fieldMgrDialog = ref(false);
const fieldDialog = ref(false);
const fieldForm = reactive<any>({
  id: null, fieldKey: '', label: '', type: 'text', required: false, options: [] as string[], sortOrder: 0,
});
const activeFields = computed(() => allFields.value.filter((f) => f.active));

// 产品一键打印
const printDialog = ref(false);
const printProduct = ref<any>(null);
const productBatches = ref<any[]>([]);
const printForm = reactive<any>({ printerId: undefined, copies: 1, useBatches: false, batchNos: [] as string[] });

// 批量绑定
const selectedMaterials = ref<any[]>([]);
const categories = ref<string[]>([]);
const bindDialog = ref(false);
const bindForm = reactive<any>({
  scope: 'selected', category: '', groupId: undefined as number | undefined,
  templateId: undefined as number | null | undefined,
});

// 产品分组
const groups = ref<any[]>([]);
const groupLoading = ref(false);
const groupTypeFilter = ref('');
const groupDialog = ref(false);
const groupForm = reactive<any>({
  id: null, code: '', name: '', type: 'custom', defaultWarehouseId: undefined, defaultLocationId: undefined,
});
const locBindDialog = ref(false);
const locBindForm = reactive<any>({
  scope: 'selected', groupId: undefined as number | undefined,
  warehouseId: undefined as number | undefined, locationId: undefined as number | undefined,
});
const typeLabel = (t: string) => ({ brand: '品牌', supplier: '供应商', custom: '自定义' }[t] ?? t);

const warehouses = ref<any[]>([]);
const whShowInactive = ref(false);
const whLoading = ref(false);
const whDialog = ref(false);
const whForm = reactive<any>({ id: null, code: '', name: '' });
const activeWarehouses = computed(() => warehouses.value.filter((w) => w.active));

const locations = ref<any[]>([]);
const locWarehouse = ref<number | undefined>();
const locKeyword = ref('');
const locShowInactive = ref(false);
const locLoading = ref(false);
const locDialog = ref(false);
const locForm = reactive<any>({ id: null, warehouseId: undefined, code: '', name: '', zone: '' });

async function loadMaterials() {
  matLoading.value = true;
  try {
    materials.value = await apiMdMaterials({
      keyword: matKeyword.value || undefined,
      includeInactive: matShowInactive.value ? 'true' : undefined,
      limit: 100,
    });
  } finally { matLoading.value = false; }
}
async function loadGroups() {
  groupLoading.value = true;
  try {
    groups.value = await apiMdGroups({ type: groupTypeFilter.value || undefined, limit: 100 });
  } finally { groupLoading.value = false; }
}
function openGroup(row?: any) {
  Object.assign(groupForm, row
    ? {
      id: row.id, code: row.code, name: row.name, type: row.type,
      defaultWarehouseId: row.defaultWarehouseId ?? undefined,
      defaultLocationId: row.defaultLocationId ?? undefined,
    }
    : {
      id: null, code: '', name: '', type: 'custom',
      defaultWarehouseId: undefined, defaultLocationId: undefined,
    });
  groupDialog.value = true;
}
async function saveGroup() {
  if (!groupForm.code || !groupForm.name) return ElMessage.warning('编码与名称必填');
  saving.value = true;
  try {
    const payload = {
      name: groupForm.name, type: groupForm.type,
      defaultWarehouseId: groupForm.defaultWarehouseId ?? null,
      defaultLocationId: groupForm.defaultLocationId ?? null,
    };
    if (groupForm.id) await apiMdUpdateGroup(groupForm.id, payload);
    else await apiMdCreateGroup({ code: groupForm.code, ...payload });
    ElMessage.success('已保存'); groupDialog.value = false; await loadGroups();
  } finally { saving.value = false; }
}
function openLocBind() {
  if (!selectedMaterials.value.length) return ElMessage.warning('请先勾选产品');
  locBindForm.scope = 'selected';
  locBindForm.groupId = groups.value[0]?.id;
  locBindForm.warehouseId = undefined;
  locBindForm.locationId = undefined;
  locBindDialog.value = true;
}
async function submitLocBind() {
  if (locBindForm.scope === 'group' && !locBindForm.groupId) return ElMessage.warning('请选择产品分组');
  saving.value = true;
  try {
    const r = await apiMdSetDefaultLocation({
      materialIds: locBindForm.scope === 'selected' ? selectedMaterials.value.map((x) => x.id) : undefined,
      groupId: locBindForm.scope === 'group' ? locBindForm.groupId : undefined,
      warehouseId: locBindForm.warehouseId ?? null,
      locationId: locBindForm.locationId ?? null,
    });
    ElMessage.success(`已联动设置 ${r?.updated ?? 0} 个产品的默认位置`);
    locBindDialog.value = false;
    selectedMaterials.value = [];
    await loadMaterials();
    await loadGroups();
  } finally { saving.value = false; }
}

async function toggleGroup(row: any) {
  await apiMdGroupActive(row.id, !row.active);
  ElMessage.success(row.active ? '已停用' : '已启用');
  await loadGroups();
}

async function loadWarehouses() {
  whLoading.value = true;
  try { warehouses.value = await apiMdWarehouses(whShowInactive.value); }
  finally { whLoading.value = false; }
}
async function loadLocations() {
  locLoading.value = true;
  try {
    locations.value = await apiMdLocations({
      warehouseId: locWarehouse.value,
      keyword: locKeyword.value || undefined,
      includeInactive: locShowInactive.value ? 'true' : undefined,
    });
  } finally { locLoading.value = false; }
}

function openMat(row?: any) {
  Object.assign(matForm, row ? {
    id: row.id, code: row.code, name: row.name, spec: row.spec ?? '',
    unit: row.unit, category: row.category ?? '', safetyStock: Number(row.safetyStock),
    templateId: row.templateId ?? undefined, groupId: row.groupId ?? undefined,
    autoPrint: !!row.autoPrint, printerId: row.printerId ?? undefined,
    defaultWarehouseId: row.defaultWarehouseId ?? undefined,
    defaultLocationId: row.defaultLocationId ?? undefined,
    customFields: { ...(row.customFields || {}) },
  } : {
    id: null, code: '', name: '', spec: '', unit: '件', category: '', safetyStock: 0,
    templateId: undefined, groupId: undefined, autoPrint: false, printerId: undefined,
    defaultWarehouseId: undefined, defaultLocationId: undefined, customFields: {},
  });
  matDialog.value = true;
}
async function saveMat() {
  if (!matForm.code || !matForm.name) return ElMessage.warning('编码与名称必填');
  saving.value = true;
  try {
    const payload = {
      name: matForm.name, spec: matForm.spec || null, unit: matForm.unit,
      category: matForm.category || null, safetyStock: Number(matForm.safetyStock) || 0,
      templateId: matForm.templateId ?? null,
      groupId: matForm.groupId ?? null,
      autoPrint: !!matForm.autoPrint,
      printerId: matForm.printerId ?? null,
      defaultWarehouseId: matForm.defaultWarehouseId ?? null,
      defaultLocationId: matForm.defaultLocationId ?? null,
      customFields: matForm.customFields || {},
    };
    if (matForm.id) await apiMdUpdateMaterial(matForm.id, payload);
    else await apiMdCreateMaterial({ code: matForm.code, ...payload });
    ElMessage.success('已保存'); matDialog.value = false; await loadMaterials();
  } finally { saving.value = false; }
}
async function toggleMat(row: any) {
  await apiMdMaterialActive(row.id, !row.active);
  ElMessage.success(row.active ? '已停用' : '已启用');
  await loadMaterials();
}

// ---------------- 自定义字段 ----------------
async function loadFields() {
  fieldLoading.value = true;
  try {
    allFields.value = await apiMdFields(fieldShowInactive.value);
  } finally { fieldLoading.value = false; }
}
function openFieldMgr() { fieldMgrDialog.value = true; loadFields(); }
function openField(row?: any) {
  Object.assign(fieldForm, row ? {
    id: row.id, fieldKey: row.fieldKey, label: row.label, type: row.type,
    required: !!row.required, options: [...(row.options || [])], sortOrder: row.sortOrder ?? 0,
  } : {
    id: null, fieldKey: '', label: '', type: 'text', required: false, options: [], sortOrder: 0,
  });
  fieldDialog.value = true;
}
async function saveField() {
  if (!fieldForm.fieldKey || !fieldForm.label) return ElMessage.warning('字段名称与标识必填');
  if ((fieldForm.type === 'select' || fieldForm.type === 'multiselect') && !fieldForm.options.length) {
    return ElMessage.warning('单选/多选字段请至少添加一个选项');
  }
  saving.value = true;
  try {
    const payload: any = {
      label: fieldForm.label, type: fieldForm.type, required: !!fieldForm.required,
      options: fieldForm.options, sortOrder: Number(fieldForm.sortOrder) || 0,
    };
    if (fieldForm.id) await apiMdUpdateField(fieldForm.id, payload);
    else await apiMdCreateField({ fieldKey: fieldForm.fieldKey, ...payload });
    ElMessage.success('已保存'); fieldDialog.value = false; await loadFields();
  } finally { saving.value = false; }
}
async function toggleField(row: any) {
  await apiMdFieldActive(row.id, !row.active);
  ElMessage.success(row.active ? '已停用' : '已启用');
  await loadFields();
}

function onMatSelection(rows: any[]) { selectedMaterials.value = rows; }

function openBind(scope = 'selected') {
  if (scope === 'selected' && !selectedMaterials.value.length) {
    ElMessage.warning('请先在列表里勾选产品');
    return;
  }
  bindForm.scope = scope;
  bindForm.category = categories.value[0] ?? '';
  bindForm.groupId = groups.value[0]?.id;
  bindForm.templateId = templates.value[0]?.id ?? null;
  bindDialog.value = true;
}

async function submitBind() {
  if (bindForm.scope === 'category' && !bindForm.category) return ElMessage.warning('请选择产品类别');
  if (bindForm.scope === 'group' && !bindForm.groupId) return ElMessage.warning('请选择产品分组');
  const payload: any = {
    templateId: bindForm.templateId ?? null,
    materialIds: bindForm.scope === 'selected' ? selectedMaterials.value.map((x) => x.id) : undefined,
    category: bindForm.scope === 'category' ? bindForm.category : undefined,
    groupId: bindForm.scope === 'group' ? bindForm.groupId : undefined,
    onlyUnbound: bindForm.scope === 'unbound' ? true : undefined,
  };
  saving.value = true;
  try {
    const r = await apiMdBindTemplate(payload);
    ElMessage.success(`已${bindForm.templateId == null ? '解除绑定' : '绑定'} ${r?.updated ?? 0} 个产品`);
    bindDialog.value = false;
    selectedMaterials.value = [];
    await loadMaterials();
  } finally { saving.value = false; }
}

async function openPrint(row: any) {
  printProduct.value = row;
  printForm.printerId = printers.value.find((p) => p.isDefault)?.id ?? printers.value[0]?.id;
  printForm.copies = 1;
  printForm.useBatches = false;
  printForm.batchNos = [];
  productBatches.value = [];
  printDialog.value = true;
  try {
    const r = await apiQueryStock({ groupBy: 'batch', keyword: row.code, limit: 100 });
    productBatches.value = (r?.items ?? []).filter((x: any) => x.materialId === row.id);
  } catch { /* 拦截器已提示 */ }
}

async function submitPrint() {
  if (!printForm.printerId) return ElMessage.warning('请选择打印机');
  if (printForm.useBatches && !printForm.batchNos.length) return ElMessage.warning('请至少勾选一个批次');
  saving.value = true;
  try {
    const r = await apiMdPrintMaterial(printProduct.value.id, {
      printerId: printForm.printerId,
      copies: printForm.copies,
      batchNos: printForm.useBatches ? printForm.batchNos : undefined,
    });
    ElMessage.success(`打印任务已提交：${r?.total ?? 1} 张标签`);
    printDialog.value = false;
  } finally { saving.value = false; }
}

function openWh(row?: any) {
  Object.assign(whForm, row ? { id: row.id, code: row.code, name: row.name } : { id: null, code: '', name: '' });
  whDialog.value = true;
}
async function saveWh() {
  if (!whForm.code || !whForm.name) return ElMessage.warning('编码与名称必填');
  saving.value = true;
  try {
    if (whForm.id) await apiMdUpdateWarehouse(whForm.id, { name: whForm.name });
    else await apiMdCreateWarehouse({ code: whForm.code, name: whForm.name });
    ElMessage.success('已保存'); whDialog.value = false; await loadWarehouses();
  } finally { saving.value = false; }
}
async function toggleWh(row: any) {
  await apiMdWarehouseActive(row.id, !row.active);
  ElMessage.success(row.active ? '已停用' : '已启用');
  await loadWarehouses();
}

function openLoc(row?: any) {
  Object.assign(locForm, row ? {
    id: row.id, warehouseId: row.warehouseId, code: row.code, name: row.name, zone: row.zone ?? '',
  } : { id: null, warehouseId: locWarehouse.value, code: '', name: '', zone: '' });
  locDialog.value = true;
}
async function saveLoc() {
  if (!locForm.warehouseId || !locForm.code || !locForm.name) return ElMessage.warning('仓库、编码与名称必填');
  saving.value = true;
  try {
    const payload = { name: locForm.name, zone: locForm.zone || null };
    if (locForm.id) await apiMdUpdateLocation(locForm.id, payload);
    else await apiMdCreateLocation({ warehouseId: locForm.warehouseId, code: locForm.code, ...payload });
    ElMessage.success('已保存'); locDialog.value = false; await loadLocations();
  } finally { saving.value = false; }
}
async function toggleLoc(row: any) {
  await apiMdLocationActive(row.id, !row.active);
  ElMessage.success(row.active ? '已停用' : '已启用');
  await loadLocations();
}

onMounted(async () => {
  const [tpls, ps, cats, gs] = await Promise.all([
    apiListTemplates({ pageSize: 200 }), apiListPrinters(),
    apiMdMaterialCategories(), apiMdGroups({ limit: 100 }),
  ]);
  templates.value = tpls?.[0] ?? [];
  printers.value = ps ?? [];
  categories.value = cats ?? [];
  groups.value = gs ?? [];
  await loadWarehouses();
  await Promise.all([loadMaterials(), loadLocations(), loadFields()]);
});
</script>

<style scoped>
.page-head { display: flex; align-items: baseline; gap: 12px; }
.hint { color: #909399; font-size: 13px; }
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.muted { color: #c0c4cc; }
.field-hint { color: #909399; font-size: 12px; line-height: 1.6; margin-top: 4px; }
.field-mgr-tip { color: #606266; font-size: 12px; line-height: 1.7; background: #f4f4f5; padding: 8px 12px; border-radius: 4px; }
.field-mgr-tip code { color: #409eff; }
.print-info { background: #f4f4f5; border-radius: 4px; padding: 10px 12px; margin-bottom: 14px; line-height: 1.9; }
.batch-list { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; }
</style>
