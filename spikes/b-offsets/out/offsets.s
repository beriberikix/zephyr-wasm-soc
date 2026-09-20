	.file	"offsets_sample.c"
	.functype	_OffsetAbsSyms () -> ()
	.section	.text._OffsetAbsSyms,"",@
	.hidden	_OffsetAbsSyms                  # -- Begin function _OffsetAbsSyms
	.globl	_OffsetAbsSyms
	.type	_OffsetAbsSyms,@function
_OffsetAbsSyms:                         # @_OffsetAbsSyms
	.functype	_OffsetAbsSyms () -> ()
# %bb.0:
                                        # fallthrough-return
	end_function
                                        # -- End function
	.hidden	___callee_saved_t_sp_OFFSET     # @___callee_saved_t_sp_OFFSET
	.type	___callee_saved_t_sp_OFFSET,@object
	.section	z_offsets,"R",@
	.globl	___callee_saved_t_sp_OFFSET
	.p2align	2, 0x0
___callee_saved_t_sp_OFFSET:
	.int32	0                               # 0x0
	.size	___callee_saved_t_sp_OFFSET, 4

	.hidden	___callee_saved_t_asyncify_buf_OFFSET # @___callee_saved_t_asyncify_buf_OFFSET
	.type	___callee_saved_t_asyncify_buf_OFFSET,@object
	.globl	___callee_saved_t_asyncify_buf_OFFSET
	.p2align	2, 0x0
___callee_saved_t_asyncify_buf_OFFSET:
	.int32	4                               # 0x4
	.size	___callee_saved_t_asyncify_buf_OFFSET, 4

	.hidden	__callee_saved_t_SIZEOF         # @__callee_saved_t_SIZEOF
	.type	__callee_saved_t_SIZEOF,@object
	.globl	__callee_saved_t_SIZEOF
	.p2align	2, 0x0
__callee_saved_t_SIZEOF:
	.int32	8                               # 0x8
	.size	__callee_saved_t_SIZEOF, 4

	.hidden	__struct_arch_esf_pc_OFFSET     # @__struct_arch_esf_pc_OFFSET
	.type	__struct_arch_esf_pc_OFFSET,@object
	.globl	__struct_arch_esf_pc_OFFSET
	.p2align	2, 0x0
__struct_arch_esf_pc_OFFSET:
	.int32	4                               # 0x4
	.size	__struct_arch_esf_pc_OFFSET, 4

	.type	_OffsetAbsSyms.___cpu_t_current_OFFSET,@object # @_OffsetAbsSyms.___cpu_t_current_OFFSET
	.p2align	2, 0x0
_OffsetAbsSyms.___cpu_t_current_OFFSET:
	.int32	0                               # 0x0
	.size	_OffsetAbsSyms.___cpu_t_current_OFFSET, 4

	.type	_OffsetAbsSyms.___cpu_t_nested_OFFSET,@object # @_OffsetAbsSyms.___cpu_t_nested_OFFSET
	.p2align	2, 0x0
_OffsetAbsSyms.___cpu_t_nested_OFFSET:
	.int32	4                               # 0x4
	.size	_OffsetAbsSyms.___cpu_t_nested_OFFSET, 4

	.type	_OffsetAbsSyms.___cpu_t_irq_stack_OFFSET,@object # @_OffsetAbsSyms.___cpu_t_irq_stack_OFFSET
	.p2align	2, 0x0
_OffsetAbsSyms.___cpu_t_irq_stack_OFFSET:
	.int32	8                               # 0x8
	.size	_OffsetAbsSyms.___cpu_t_irq_stack_OFFSET, 4

	.type	_OffsetAbsSyms.___thread_t_callee_saved_OFFSET,@object # @_OffsetAbsSyms.___thread_t_callee_saved_OFFSET
	.p2align	2, 0x0
_OffsetAbsSyms.___thread_t_callee_saved_OFFSET:
	.int32	0                               # 0x0
	.size	_OffsetAbsSyms.___thread_t_callee_saved_OFFSET, 4

	.type	_OffsetAbsSyms.___thread_t_init_data_OFFSET,@object # @_OffsetAbsSyms.___thread_t_init_data_OFFSET
	.p2align	2, 0x0
_OffsetAbsSyms.___thread_t_init_data_OFFSET:
	.int32	8                               # 0x8
	.size	_OffsetAbsSyms.___thread_t_init_data_OFFSET, 4

	.type	_OffsetAbsSyms.___thread_t_prio_OFFSET,@object # @_OffsetAbsSyms.___thread_t_prio_OFFSET
	.p2align	2, 0x0
_OffsetAbsSyms.___thread_t_prio_OFFSET:
	.int32	12                              # 0xc
	.size	_OffsetAbsSyms.___thread_t_prio_OFFSET, 4

	.type	_OffsetAbsSyms.__thread_t_SIZEOF,@object # @_OffsetAbsSyms.__thread_t_SIZEOF
	.p2align	2, 0x0
_OffsetAbsSyms.__thread_t_SIZEOF:
	.int32	16                              # 0x10
	.size	_OffsetAbsSyms.__thread_t_SIZEOF, 4

	.no_dead_strip	_OffsetAbsSyms.___cpu_t_current_OFFSET
	.no_dead_strip	_OffsetAbsSyms.___cpu_t_irq_stack_OFFSET
	.no_dead_strip	_OffsetAbsSyms.___cpu_t_nested_OFFSET
	.no_dead_strip	_OffsetAbsSyms.___thread_t_callee_saved_OFFSET
	.no_dead_strip	_OffsetAbsSyms.___thread_t_init_data_OFFSET
	.no_dead_strip	_OffsetAbsSyms.___thread_t_prio_OFFSET
	.no_dead_strip	_OffsetAbsSyms.__thread_t_SIZEOF
	.no_dead_strip	___callee_saved_t_asyncify_buf_OFFSET
	.no_dead_strip	___callee_saved_t_sp_OFFSET
	.no_dead_strip	__callee_saved_t_SIZEOF
	.no_dead_strip	__struct_arch_esf_pc_OFFSET
	.ident	"Homebrew clang version 23.1.1"
	.section	.custom_section.producers,"",@
	.int8	1
	.int8	12
	.ascii	"processed-by"
	.int8	1
	.int8	14
	.ascii	"Homebrew clang"
	.int8	6
	.ascii	"23.1.1"
	.section	z_offsets,"R",@
	.section	.custom_section.target_features,"",@
	.int8	8
	.int8	43
	.int8	11
	.ascii	"bulk-memory"
	.int8	43
	.int8	15
	.ascii	"bulk-memory-opt"
	.int8	43
	.int8	22
	.ascii	"call-indirect-overlong"
	.int8	43
	.int8	10
	.ascii	"multivalue"
	.int8	43
	.int8	15
	.ascii	"mutable-globals"
	.int8	43
	.int8	19
	.ascii	"nontrapping-fptoint"
	.int8	43
	.int8	15
	.ascii	"reference-types"
	.int8	43
	.int8	8
	.ascii	"sign-ext"
	.section	z_offsets,"R",@
