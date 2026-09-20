	.file	"q4_infunc.c"
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
	.type	_OffsetAbsSyms.__k_thread_t_b_OFFSET,@object # @_OffsetAbsSyms.__k_thread_t_b_OFFSET
	.section	z_offsets,"R",@
	.p2align	2, 0x0
_OffsetAbsSyms.__k_thread_t_b_OFFSET:
	.int32	4                               # 0x4
	.size	_OffsetAbsSyms.__k_thread_t_b_OFFSET, 4

	.type	_OffsetAbsSyms.__k_thread_t_d_OFFSET,@object # @_OffsetAbsSyms.__k_thread_t_d_OFFSET
	.p2align	2, 0x0
_OffsetAbsSyms.__k_thread_t_d_OFFSET:
	.int32	16                              # 0x10
	.size	_OffsetAbsSyms.__k_thread_t_d_OFFSET, 4

	.type	_OffsetAbsSyms.__k_thread_t_SIZEOF,@object # @_OffsetAbsSyms.__k_thread_t_SIZEOF
	.p2align	2, 0x0
_OffsetAbsSyms.__k_thread_t_SIZEOF:
	.int32	24                              # 0x18
	.size	_OffsetAbsSyms.__k_thread_t_SIZEOF, 4

	.no_dead_strip	_OffsetAbsSyms.__k_thread_t_SIZEOF
	.no_dead_strip	_OffsetAbsSyms.__k_thread_t_b_OFFSET
	.no_dead_strip	_OffsetAbsSyms.__k_thread_t_d_OFFSET
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
